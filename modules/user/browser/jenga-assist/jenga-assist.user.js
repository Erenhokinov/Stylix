// ==UserScript==
// @name         JENGA ASSIST — best-block advisor for Jenga World Web
// @namespace    jenga-assist
// @version      0.1.0
// @description  Scores every removable Jenga block with a structural heuristic and highlights the safest one. Advisory only — physics is approximate.
// @match        https://html-classic.itch.zone/html/20431350/*
// @match        https://shyhumangames.itch.io/jenga-world-web*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ============================================================
 * JENGA ASSIST
 * Reads live tower state from Jenga World Web's internal game
 * object (found via React fiber traversal), scores candidate
 * blocks with a contact-graph/load-flow heuristic, tints the
 * recommended block's mesh and shows a HUD.
 *
 * Heuristic basis: Wang et al. IROS'09 (robot Jenga planner),
 * Kimura et al. (friction during extraction), Fazeli et al.
 * arXiv:2505.09377 (contact-graph block selection). It is an
 * advisory ranker, NOT a physics proof — stressed/friction-held
 * blocks can still topple the tower.
 * ========================================================== */

(function () {
  'use strict';

  // === CONFIG ===
  const CFG = {
    L: 0.30, W: 0.10, H: 0.06,   // block dims (world units; pitch=0.06, slot spacing=0.1)
    PER_LAYER: 3,
    POLL_MS: 400,
    RESCAN_MS: 2000,
    DEBOUNCE_MS: 350,
    TOP_N: 5,
    W_LOAD: 0.30, W_DEP: 0.25, W_POSE: 0.15, W_JAM: 0.15, W_HEIGHT: 0.10, W_LEAN: 0.05,
    VETO_TILT_DEG: 30,
    DEBUG: new URLSearchParams(location.search).has('ja_debug'),
  };

  // === VECTOR / QUAT HELPERS ===
  const V = {
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    norm: a => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; },
    horiz: a => ({ x: a.x, y: 0, z: a.z }),
  };
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  function qrot(q, v) {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const tx = 2 * (qy * v.z - qz * v.y);
    const ty = 2 * (qz * v.x - qx * v.z);
    const tz = 2 * (qx * v.y - qy * v.x);
    return {
      x: v.x + qw * tx + (qy * tz - qz * ty),
      y: v.y + qw * ty + (qz * tx - qx * tz),
      z: v.z + qw * tz + (qx * ty - qy * tx),
    };
  }

  // === GAME DISCOVERY (React fiber walk) ===
  let game = null, lastScan = 0;

  function isGame(v) {
    try { return v && typeof v === 'object' && v.world && v.match && typeof v.viewState === 'function'; }
    catch (e) { return false; }
  }

  function gameScore(v) {
    // prefer live, started instances over menu/preview/disposed ones
    let s = 0;
    try {
      if (v.started) s += 4;
      if (v.world && v.world.world) s += 2;          // live Rapier world
      const vs = v.viewState();
      if (vs && ['solo', 'local', 'online'].includes(vs.mode)) s += 2;
      if (vs && !['lounge', 'menu', 'title', 'results', 'collapse'].includes(vs.phase)) s += 1;
    } catch (e) {}
    return s;
  }

  function findGame() {
    let best = null, bestScore = -1;
    for (const el of document.querySelectorAll('*')) {
      const k = Object.keys(el).find(k => k.startsWith('__reactContainer'));
      if (!k) continue;
      let f = el[k], hops = 0;
      while (f && f.return && hops++ < 100) f = f.return;
      const seen = new Set(), stack = [f];
      while (stack.length) {
        const n = stack.pop();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        let h = n.memoizedState, g = 0;
        const guard = new Set();
        while (h && g++ < 80 && !guard.has(h)) {
          guard.add(h);
          if (isGame(h.memoizedState)) {
            const s = gameScore(h.memoizedState);
            if (s > bestScore) { bestScore = s; best = h.memoizedState; }
          }
          h = h.next;
        }
        if (n.child) stack.push(n.child);
        if (n.sibling) stack.push(n.sibling);
      }
    }
    if (bestScore > 0) { game = best; return game; }
    return null;
  }

  // === BLOCK MODEL ===
  // local axes: x = long (L), y = up (H), z = width (W)
  function blockBasis(b) {
    const q = b.rotation || { x: 0, y: 0, z: 0, w: 1 };
    return {
      u: V.norm(qrot(q, { x: 1, y: 0, z: 0 })),
      n: V.norm(qrot(q, { x: 0, y: 1, z: 0 })),
      s: V.norm(qrot(q, { x: 0, y: 0, z: 1 })),
    };
  }
  function halfHeight(b) {
    const { u, n, s } = blockBasis(b);
    return 0.5 * (Math.abs(n.y) * CFG.H + Math.abs(u.y) * CFG.L + Math.abs(s.y) * CFG.W);
  }

  // horizontal OBB overlap area via grid sampling
  // r = {cx, cz, ax, az (unit dir1), hx (half len1), bx, bz (unit dir2), hz (half len2)}
  function insideRect(px, pz, r) {
    const dx = px - r.cx, dz = pz - r.cz;
    return Math.abs(dx * r.ax + dz * r.az) <= r.hx + 1e-6 &&
           Math.abs(dx * r.bx + dz * r.bz) <= r.hz + 1e-6;
  }
  function rectOf(b) {
    const uh = V.norm(V.horiz(b.u)), sh = V.norm(V.horiz(b.s));
    // ensure sh is perpendicular-ish to uh in XZ
    return { cx: b.pos.x, cz: b.pos.z, ax: uh.x, az: uh.z, hx: CFG.L / 2, bx: sh.x, bz: sh.z, hz: CFG.W / 2 };
  }
  function footprintOverlap(ra, rb) {
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (const r of [ra, rb]) for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
      const px = r.cx + s1 * r.hx * r.ax + s2 * r.hz * r.bx;
      const pz = r.cz + s1 * r.hx * r.az + s2 * r.hz * r.bz;
      minx = Math.min(minx, px); maxx = Math.max(maxx, px);
      minz = Math.min(minz, pz); maxz = Math.max(maxz, pz);
    }
    const N = 8, cw = (maxx - minx) / N, cd = (maxz - minz) / N;
    let inter = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const px = minx + (i + 0.5) * cw, pz = minz + (j + 0.5) * cd;
      if (insideRect(px, pz, ra) && insideRect(px, pz, rb)) inter += cw * cd;
    }
    return inter;
  }

  // === HEURISTIC ===
  function advise(snapshot, eligibleIds) {
    const blocks = snapshot.map(b => {
      const { u, n, s } = blockBasis(b);
      return {
        id: b.id, pos: b.position, rot: b.rotation, layer: b.layer, slot: b.slot,
        u, n, s, uh: V.norm(V.horiz(u)), sh: V.norm(V.horiz(s)),
        rect: null, sleeping: b.sleeping,
        eligible: eligibleIds ? eligibleIds.has(b.id) : true,
      };
    });
    for (const b of blocks) b.rect = rectOf(b);

    // group by y into layers, sorted bottom->top
    const byY = [...blocks].sort((a, b) => a.pos.y - b.pos.y);
    const groups = [];
    for (const b of byY) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(b.pos.y - g.meanY) < CFG.H * 0.6) {
        g.items.push(b);
        g.meanY = g.items.reduce((s, x) => s + x.pos.y, 0) / g.items.length;
      } else groups.push({ meanY: b.pos.y, items: [b] });
    }
    groups.forEach((g, rank) => g.items.forEach(b => { b.rank = rank; b.group = g; }));
    gfix(groups);
    const minRank = 0, maxRank = groups.length - 1;

    function gfix(gs) {
      for (const g of gs) {
        let ref = null, acc = { x: 0, z: 0 };
        for (const b of g.items) {
          let uh = b.uh;
          if (ref && (uh.x * ref.x + uh.z * ref.z) < 0) uh = { x: -uh.x, z: -uh.z };
          if (!ref) ref = uh;
          acc.x += uh.x; acc.z += uh.z;
        }
        g.meanU = V.norm({ x: acc.x, y: 0, z: acc.z });
        g.count = g.items.length;
        g.center = {
          x: g.items.reduce((s, b) => s + b.pos.x, 0) / g.count,
          z: g.items.reduce((s, b) => s + b.pos.z, 0) / g.count,
        };
      }
    }

    // support graph
    const supports = new Map(), dependents = new Map();
    for (const up of blocks) {
      const sup = [], upHH = halfHeight(up);
      for (const low of blocks) {
        if (low === up || low.pos.y >= up.pos.y) continue;
        const gap = (up.pos.y - upHH) - (low.pos.y + halfHeight(low));
        if (gap < -CFG.H * 0.6 || gap > CFG.H * 0.9) continue;
        const area = footprintOverlap(up.rect, low.rect);
        const minArea = Math.min(4 * CFG.L * CFG.W, 4 * CFG.L * CFG.W);
        if (area > 0.04 * minArea) sup.push({ low: low.id, area });
      }
      supports.set(up.id, sup);
      for (const s of sup) {
        (dependents.get(s.low) || dependents.set(s.low, []).get(s.low)).push({ upper: up.id, area: s.area });
      }
    }

    // carried load flow, top -> bottom
    const totalMass = blocks.length;
    const carried = new Map(blocks.map(b => [b.id, 1]));
    for (const g of [...groups].sort((a, b) => b.meanY - a.meanY)) {
      for (const b of g.items) {
        const load = carried.get(b.id);
        const sup = supports.get(b.id) || [];
        if (!sup.length) continue;
        const tot = sup.reduce((s, x) => s + x.area, 0) || 1;
        for (const s of sup) carried.set(s.low, (carried.get(s.low) || 1) + load * s.area / tot);
      }
    }

    // base COM margin
    const baseG = groups[0];
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    if (baseG) for (const b of baseG.items) {
      const r = b.rect;
      for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
        const px = r.cx + s1 * r.hx * r.ax + s2 * r.hz * r.bx;
        const pz = r.cz + s1 * r.hx * r.az + s2 * r.hz * r.bz;
        minx = Math.min(minx, px); maxx = Math.max(maxx, px);
        minz = Math.min(minz, pz); maxz = Math.max(maxz, pz);
      }
    }
    const com = {
      x: blocks.reduce((s, b) => s + b.pos.x, 0) / blocks.length,
      z: blocks.reduce((s, b) => s + b.pos.z, 0) / blocks.length,
    };
    const baseCx = (minx + maxx) / 2, baseCz = (minz + maxz) / 2;
    const baseRx = Math.max(0.05, (maxx - minx) / 2), baseRz = Math.max(0.05, (maxz - minz) / 2);
    const margin = Math.min(baseRx - Math.abs(com.x - baseCx), baseRz - Math.abs(com.z - baseCz));
    const scale = 0.08 * Math.min(baseRx, baseRz);
    const globalRisk = clamp((scale - margin) / scale, 0, 1);

    // legal rank cutoff (official Jenga top-layer rule)
    const topG = groups[maxRank];
    const maxLegalRank = topG.count >= CFG.PER_LAYER ? maxRank - 1 : maxRank - 2;
    const byId = new Map(blocks.map(b => [b.id, b]));

    const results = [];
    for (const c of blocks) {
      if (!c.eligible) continue;
      const g = c.group, flags = [];
      let depRisk = 0, veto = null;

      if (g.count <= 1) veto = 'LAST_IN_LAYER';

      const deps = dependents.get(c.id) || [];
      for (const d of deps) {
        const up = byId.get(d.upper);
        if (!up) continue;
        const sup = (supports.get(up.id) || []).filter(s => s.low !== c.id);
        const totArea = (supports.get(up.id) || []).reduce((s, x) => s + x.area, 0) || 1;
        const lostShare = d.area / totArea;
        let r;
        if (sup.length === 0) r = 1.0;
        else if (sup.length === 1) r = 0.95;
        else if (sup.length === 2) r = 0.35 + 0.35 * lostShare;
        else if (sup.length === 3) r = 0.15 + 0.25 * lostShare;
        else r = 0.10 + 0.15 * lostShare;
        depRisk = Math.max(depRisk, r);
        if (sup.length === 0 && !veto) { veto = 'SOLE_SUPPORT'; flags.push('sole support above'); }
      }

      // center test: is this block nearest its layer center in a full layer?
      const dists = g.items.map(b => Math.hypot(b.pos.x - g.center.x, b.pos.z - g.center.z)).sort((a, b) => a - b);
      const distC = Math.hypot(c.pos.x - g.center.x, c.pos.z - g.center.z);
      const isCenterBlock = g.count === CFG.PER_LAYER && distC <= dists[0] + 1e-6;
      const policy = g.count === 1 ? 1.0 : g.count === 2 ? 0.80 : isCenterBlock ? 0.42 : 0.55;
      depRisk = Math.max(depRisk, policy * 0.5);

      // pose
      const upDot = Math.abs(c.n.y);
      const tiltDeg = Math.acos(clamp(upDot, -1, 1)) * 180 / Math.PI;
      const tiltN = clamp(tiltDeg / 12, 0, 1);
      const yawAlign = Math.abs(c.uh.x * g.meanU.x + c.uh.z * g.meanU.z);
      const yawN = clamp((1 - yawAlign) / 0.35, 0, 1);
      const seatN = clamp(Math.abs(c.pos.y - g.meanY) / CFG.H / 0.75, 0, 1);
      const supCount = (supports.get(c.id) || []).length;
      const underN = clamp((2 - supCount) / 2, 0, 1);
      const poseN = Math.max(tiltN, yawN, seatN, underN, c.sleeping ? 0 : 0.5);
      if (!c.sleeping) flags.push('moving');
      if (tiltDeg > CFG.VETO_TILT_DEG && !veto) { veto = 'TILTED'; flags.push('tilted ' + tiltDeg.toFixed(0) + '°'); }

      // jam
      const pathN = pathBlockers(c, blocks);
      const orthoN = orthoDeviation(c, groups);
      const lockN = lockScore(c);
      const jamN = clamp(0.45 * pathN + 0.30 * lockN + 0.25 * orthoN, 0, 1);

      // height & lean
      const heightN = maxLegalRank > minRank ? (maxLegalRank - c.rank) / (maxLegalRank - minRank) : 0.5;
      const dxc = c.pos.x - com.x, dzc = c.pos.z - com.z;
      const dl = Math.hypot(com.x - baseCx, com.z - baseCz) || 1;
      const dc = Math.hypot(dxc, dzc);
      const benefit = dc > 1e-6 ? (dxc * (com.x - baseCx) + dzc * (com.z - baseCz)) / (dc * dl) : 0;
      const leanN = Math.max(globalRisk * 0.8, clamp(-benefit, 0, 1) * 0.3);

      // load
      const loadShare = (carried.get(c.id) || 1) / totalMass;
      const loadN = clamp(loadShare / (1.05 / CFG.PER_LAYER), 0, 1);
      if (loadN > 0.75) flags.push('high load');
      if (supCount === 1) flags.push('single support below');
      if (g.count === 2) flags.push('2 left in layer');

      const risk = CFG.W_LOAD * loadN + CFG.W_DEP * depRisk + CFG.W_POSE * poseN +
                   CFG.W_JAM * jamN + CFG.W_HEIGHT * heightN + CFG.W_LEAN * leanN;
      const score = clamp(Math.round(100 * (1 - risk)), 0, 100);
      const dirs = pickDirs(c, blocks);
      results.push({ id: c.id, rank: c.rank, layer: c.layer, slot: c.slot, score, flags, veto, dirs });
    }
    results.sort((a, b) => (a.veto ? 1 : 0) - (b.veto ? 1 : 0) || b.score - a.score);
    return { results, layers: groups.length, comOutside: margin < 0, globalRisk };
  }

  function pathBlockers(c, blocks) {
    let best = 99;
    for (const sgn of [1, -1]) {
      const dx = c.uh.x * sgn, dz = c.uh.z * sgn;
      let count = 0;
      for (const o of blocks) {
        if (o.id === c.id || Math.abs(o.pos.y - c.pos.y) > CFG.H * 1.5) continue;
        const rx = o.pos.x - c.pos.x, rz = o.pos.z - c.pos.z;
        const along = rx * dx + rz * dz;
        const perp = Math.abs(rx * -dz + rz * dx);
        if (along > 0.02 && along < CFG.L + CFG.W && perp < CFG.W * 0.9) count++;
      }
      best = Math.min(best, count);
    }
    return clamp(best / 3, 0, 1);
  }

  function orthoDeviation(c, groups) {
    let err = 0, n = 0;
    for (const og of [groups[c.rank - 1], groups[c.rank + 1]]) {
      if (!og || !og.meanU) continue;
      const d = Math.abs(c.uh.x * og.meanU.x + c.uh.z * og.meanU.z);
      err += d; n++;
    }
    return n ? clamp((err / n) / 0.5, 0, 1) : 0;
  }

  function lockScore(c) {
    const g = c.group;
    let m = 0;
    for (const o of g.items) {
      if (o.id === c.id) continue;
      const d = Math.abs(c.uh.x * o.uh.x + c.uh.z * o.uh.z);
      m = Math.max(m, 1 - d);
    }
    return clamp(m, 0, 1) * 0.5;
  }

  function pickDirs(c, blocks) {
    const out = [];
    for (const sgn of [1, -1]) {
      const dx = c.uh.x * sgn, dz = c.uh.z * sgn;
      let blockers = 0, clear = 0;
      for (const o of blocks) {
        if (o.id === c.id || Math.abs(o.pos.y - c.pos.y) > CFG.H * 1.5) continue;
        const rx = o.pos.x - c.pos.x, rz = o.pos.z - c.pos.z;
        const along = rx * dx + rz * dz;
        const perp = Math.abs(rx * -dz + rz * dx);
        if (perp < CFG.W * 0.9 && along > -CFG.W && along < CFG.L * 1.5) {
          if (along > 0) { blockers++; if (along > clear) clear = along; }
        }
      }
      out.push({ dir: { x: dx, z: dz }, blockers, score: 10 * (1 - blockers / 3) + 5 * clamp(clear / CFG.L, 0, 1) });
    }
    out.sort((a, b) => b.score - a.score);
    return out[0];
  }

  // === RENDERING ===
  const hud = document.createElement('div');
  hud.id = 'ja-hud';
  hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(10,14,20,.88);color:#cfe3ff;font:12px/1.45 monospace;padding:10px 12px;border-radius:8px;border:1px solid #2a4a6a;pointer-events:none;max-width:320px;white-space:pre-wrap;';
  const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrowSvg.id = 'ja-arrow';
  arrowSvg.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  arrowSvg.setAttribute('width', '100%');
  arrowSvg.setAttribute('height', '100%');

  let highlighted = null, lastHash = '', lastResult = null, scoredFor = null;

  function worldToScreen(cam, p) {
    cam.updateMatrixWorld && cam.updateMatrixWorld();
    cam.updateMatrixWorldInverse && cam.updateMatrixWorldInverse();
    const e = cam.matrixWorldInverse.elements, pr = cam.projectionMatrix.elements;
    const x = p.x, y = p.y, z = p.z;
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const vw = e[3] * x + e[7] * y + e[11] * z + e[15];
    const cx = pr[0] * vx + pr[4] * vy + pr[8] * vz + pr[12] * vw;
    const cy = pr[1] * vx + pr[5] * vy + pr[9] * vz + pr[13] * vw;
    const cw = pr[3] * vx + pr[7] * vy + pr[11] * vz + pr[15] * vw;
    if (Math.abs(cw) < 1e-9) return null;
    return { x: (cx / cw * 0.5 + 0.5) * innerWidth, y: (0.5 - cy / cw * 0.5) * innerHeight, behind: cw < 0 };
  }

  function clearHighlight() {
    if (highlighted) {
      try {
        highlighted.mesh.material = highlighted.origMat;
        highlighted.mesh.material.needsUpdate = true;
      } catch (e) {}
      highlighted = null;
    }
    arrowSvg.innerHTML = '';
  }

  function applyHighlight(best, snapById) {
    clearHighlight();
    if (!best || best.veto || !game) return;
    const mesh = game.scene && game.scene.meshes && game.scene.meshes[best.id];
    const b = snapById.get(best.id);
    if (mesh && mesh.material && !Array.isArray(mesh.material)) {
      try {
        if (mesh.material.emissive === undefined) return;
        // materials are shared across blocks — clone so only this mesh lights up
        if (!mesh.userData.__ja_origMat) mesh.userData.__ja_origMat = mesh.material;
        if (!mesh.userData.__ja_mat) {
          mesh.userData.__ja_mat = mesh.userData.__ja_origMat.clone();
        }
        mesh.material = mesh.userData.__ja_mat;
        mesh.material.emissive.setHex(0x1a5c2a);
        if (mesh.material.emissiveIntensity !== undefined) mesh.material.emissiveIntensity = 0.9;
        mesh.material.needsUpdate = true;
        highlighted = { mesh, origMat: mesh.userData.__ja_origMat };
      } catch (e) { if (CFG.DEBUG) console.log('ja tint fail', e); }
    }
    const cam = game.scene && game.scene.camera && game.scene.camera.camera;
    if (cam && b && best.dirs) {
      const c = worldToScreen(cam, b.position);
      const tip = worldToScreen(cam, {
        x: b.position.x + best.dirs.dir.x * CFG.L * 0.55,
        y: b.position.y + CFG.H * 0.15,
        z: b.position.z + best.dirs.dir.z * CFG.L * 0.55,
      });
      if (c && tip && !c.behind && !tip.behind) {
        const ns = 'http://www.w3.org/2000/svg';
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', c.x); line.setAttribute('y1', c.y);
        line.setAttribute('x2', tip.x); line.setAttribute('y2', tip.y);
        line.setAttribute('stroke', '#39ff88'); line.setAttribute('stroke-width', '5');
        line.setAttribute('stroke-linecap', 'round'); line.setAttribute('opacity', '0.9');
        arrowSvg.appendChild(line);
        const ang = Math.atan2(tip.y - c.y, tip.x - c.x), ah = 14;
        const poly = document.createElementNS(ns, 'polygon');
        poly.setAttribute('points',
          `${tip.x},${tip.y} ${tip.x - ah * Math.cos(ang - 0.45)},${tip.y - ah * Math.sin(ang - 0.45)} ${tip.x - ah * Math.cos(ang + 0.45)},${tip.y - ah * Math.sin(ang + 0.45)}`);
        poly.setAttribute('fill', '#39ff88'); poly.setAttribute('opacity', '0.9');
        arrowSvg.appendChild(poly);
      }
    }
  }

  function hashSnap(snap) {
    let h = 0;
    for (const b of snap) {
      h = (h * 31 + Math.round(b.position.x * 500) * 7 + Math.round(b.position.y * 500) * 3 + Math.round(b.position.z * 500)) | 0;
    }
    return h;
  }

  const DEAD_PHASES = ['collapse', 'results', 'lounge', 'menu', 'over', 'won', 'lost', 'title'];

  // whose move is it? online mode: only advise when this client can act
  function canAct(vs) {
    if (vs.mode === 'online' && game.online && typeof game.online.canControl === 'function') {
      try { return !!game.online.canControl(); } catch (e) { return true; }
    }
    return true;
  }

  function update() {
    ensureHud();
    // periodic rescan picks up new/re-mounted game instances (menu -> game, rematch)
    if (Date.now() - lastScan > CFG.RESCAN_MS) {
      lastScan = Date.now();
      const prev = game;
      findGame();
      if (game !== prev) { lastHash = ''; lastResult = null; lastTop = null; scoredFor = null; }
    }
    if (!game) { hud.textContent = 'JENGA ASSIST\nwaiting for game…'; return; }
    let vs, snap;
    try {
      vs = game.viewState();
      snap = game.world.snapshot();
    } catch (e) { hud.textContent = 'JENGA ASSIST\nstate error'; return; }
    if (!snap || !snap.length) { hud.textContent = 'JENGA ASSIST\nno tower'; return; }

    const phase = vs.phase || '';
    const inGame = vs.mode && !DEAD_PHASES.includes(phase);
    const myTurn = inGame && canAct(vs);
    const choosing = phase === 'select' || phase === 'aim';

    // include turn/phase/mode in the change key — tower hash alone misses turn changes
    const h = hashSnap(snap) + '|' + (vs.mode || '') + '|' + phase + '|' + (vs.turn ?? '') + '|' + (vs.activePlayer ?? '') + '|' + (vs.placements ?? '');
    const dirty = h !== lastHash;
    if (dirty) {
      lastHash = h;
      scoredFor = null;
    }
    // score whenever the tower changed; show advice only on your selection turn
    if (myTurn && h !== scoredFor) {
      scoredFor = h;
      try {
        const elig = new Set();
        for (const b of snap) { try { if (game.world.eligible(b.id)) elig.add(b.id); } catch (e) {} }
        if (!elig.size) for (const b of snap) elig.add(b.id);
        lastResult = advise(snap, elig);
        const top = lastResult.results.filter(r => !r.veto).slice(0, CFG.TOP_N);
        const byId = new Map(snap.map(b => [b.id, b]));
        renderHud(vs, top, lastResult);
        if (CFG.DEBUG) console.log('JA scored', top.map(t => `#${t.id}:${t.score}`).join(' '));
        lastTop = top; lastById = byId;
      } catch (e) { if (CFG.DEBUG) console.log('ja advise fail', e); }
    }
    // highlight only while choosing on your turn
    if (choosing && myTurn && lastTop && lastTop.length) {
      applyHighlight(lastTop[0], lastById);
    } else {
      clearHighlight();
    }
    if (!myTurn && inGame && lastResult) {
      hud.textContent = `JENGA ASSIST — ${vs.mode}\n${vs.mode === 'online' ? 'opponent\'s turn' : 'phase: ' + phase}\n${vs.message || ''}`;
    } else if (!inGame && lastResult) {
      hud.textContent = 'JENGA ASSIST\ngame over — ' + (vs.message || phase);
      lastResult = null; lastTop = null;
    }
  }
  let lastTop = null, lastById = null;

  function renderHud(vs, top, adv) {
    if (!top.length) { hud.textContent = 'JENGA ASSIST\nno candidates'; return; }
    const b = top[0];
    hud.textContent = [
      `JENGA ASSIST — ${vs.mode || ''} [${phaseName(vs)}]${vs.mode === 'local' ? ' · P' + ((vs.activePlayer ?? 0) + 1) + ' to move' : ''}`,
      `BEST: block #${b.id} (layer ${b.rank}, slot ${b.slot}) — score ${b.score}`,
      b.flags.length ? 'flags: ' + b.flags.join(', ') : 'flags: none',
      '',
      ...top.map((r, i) => `${i + 1}. #${r.id} L${r.rank} s${r.slot}  ${r.score}${r.veto ? ' VETO' : ''}`),
      '',
      adv.comOutside ? '!! tower leaning — all moves risky' : 'advisory only — physics approx',
    ].join('\n');
  }
  function phaseName(vs) { return vs.phase || ''; }

  function ensureHud() {
    if (!hud.isConnected) {
      document.documentElement.appendChild(arrowSvg);
      document.documentElement.appendChild(hud);
    }
  }

  function boot() {
    ensureHud();
    setInterval(update, CFG.POLL_MS);
    if (CFG.DEBUG) console.log('JENGA ASSIST loaded');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
