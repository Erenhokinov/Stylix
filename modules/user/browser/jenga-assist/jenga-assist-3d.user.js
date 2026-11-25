// ==UserScript==
// @name         JENGA ASSIST 3D — best-block advisor for jenga.space-z.ai
// @namespace    jenga-assist-3d
// @version      0.1.0
// @description  Scores every pullable Jenga block with a structural heuristic and highlights the safest one. Works in online multiplayer — only advises on your turn.
// @match        https://jenga.space-z.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ============================================================
 * JENGA ASSIST 3D
 * Port for jenga.space-z.ai (Next.js + R3F + Socket.io).
 * The game is server-authoritative with NO physics — blocks are
 * logical {layer,index,x,y,z,rotation} records in a Zustand store.
 * We find the store via React fiber walk, score candidates with
 * the same contact-graph/load-flow heuristic as v1, and tint the
 * block's mesh via its R3F component ref.
 *
 * Advisory only — no physics oracle exists client-side anyway.
 * ========================================================== */

(function () {
  'use strict';

  const CFG = {
    PER_LAYER: 3,
    POLL_MS: 400,
    RESCAN_MS: 2500,
    TOP_N: 5,
    W_LOAD: 0.30, W_DEP: 0.25, W_POSE: 0.15, W_JAM: 0.15, W_HEIGHT: 0.10, W_LEAN: 0.05,
    // dims auto-calibrated from block data; fallbacks below
    L: 1.5, W: 0.5, H: 0.5,
    DEBUG: new URLSearchParams(location.search).has('ja_debug'),
  };

  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const V = {
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    norm: a => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; },
    horiz: a => ({ x: a.x, y: 0, z: a.z }),
  };

  // === STORE DISCOVERY ===
  // Zustand state lives in hook memoizedState — but the VALUE is an immutable
  // snapshot that goes stale. We cache the hook NODE instead and re-read
  // memoizedState each poll; it updates in place on re-render.
  let lastScan = 0;

  function findStore() {
    // hook memoizedState snapshots go stale between renders, so re-walk each call.
    // Early-exits on first match; tree is small enough at 400ms cadence.
    let found = null;
    function walk(f, seen, d) {
      if (!f || seen.has(f) || d > 250 || found) return;
      seen.add(f);
      let h = f.memoizedState, g = 0; const gu = new Set();
      while (h && g++ < 80 && !gu.has(h)) {
        gu.add(h);
        const v = h.memoizedState;
        if (v && Array.isArray(v.blocks) && typeof v.isMyTurn === 'boolean' && v.socket !== undefined) { found = v; return; }
        h = h.next;
      }
      walk(f.child, seen, d + 1); walk(f.sibling, seen, d);
    }
    for (const el of document.querySelectorAll('*')) {
      const k = Object.keys(el).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
      if (!k) continue;
      let f = el[k], hops = 0;
      while (f && f.return && hops++ < 100) f = f.return;
      walk(f, new Set(), 0);
      if (found) break;
    }
    return found;
  }

  // === BLOCK MODEL ===
  // rotation: 0 => long axis X (tiles along Z); 90 => long axis Z (tiles along X)
  function basis(b) {
    const swap = (b.rotation || 0) % 180 !== 0;
    const u = swap ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const s = swap ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    return { u, n: { x: 0, y: 1, z: 0 }, s };
  }
  function rectOf(b) {
    const { u, s } = basis(b);
    return { cx: b.x, cz: b.z, ax: u.x, az: u.z, hx: CFG.L / 2, bx: s.x, bz: s.z, hz: CFG.W / 2, y: b.y, layer: b.layer };
  }
  function insideRect(px, pz, r) {
    const dx = px - r.cx, dz = pz - r.cz;
    return Math.abs(dx * r.ax + dz * r.az) <= r.hx + 1e-6 &&
           Math.abs(dx * r.bx + dz * r.bz) <= r.hz + 1e-6;
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

  // === HEURISTIC (adapted to logical block records) ===
  function advise(blocks) {
    // only tower blocks count
    const tower = blocks.filter(b => b && b.inTower !== false && !b.isRemoved);
    if (tower.length < 4) return { results: [], layers: 0, comOutside: false };

    // calibrate W from same-layer neighbor spacing, H from y pitch
    {
      const ys = [...new Set(tower.map(b => b.y))].sort((a, b) => a - b);
      if (ys.length > 1) { const d = ys[1] - ys[0]; if (d > 0.01 && d < 5) CFG.H = d; }
      const dists = [];
      for (const b of tower) for (const o of tower) {
        if (b.layer === o.layer && b.id !== o.id) {
          const d = Math.hypot(b.x - o.x, b.z - o.z);
          if (d > 0.01) dists.push(d);
        }
      }
      if (dists.length) { dists.sort((a, b) => a - b); CFG.W = dists[Math.floor(dists.length / 2)]; }
      CFG.L = CFG.W * 3;
    }

    const bs = tower.map(b => ({ ...b, uh: basis(b).u, sh: basis(b).s, rect: rectOf(b), rank: b.layer }));
    // group by layer for completeness/center stats
    const groups = new Map();
    for (const b of bs) {
      if (!groups.has(b.layer)) groups.set(b.layer, []);
      groups.get(b.layer).push(b);
    }
    const ranks = [...groups.keys()].sort((a, b) => a - b);
    const ginfo = new Map();
    for (const r of ranks) {
      const items = groups.get(r);
      const cx = items.reduce((s, b) => s + b.x, 0) / items.length;
      const cz = items.reduce((s, b) => s + b.z, 0) / items.length;
      // mean long axis (sign-aligned)
      let ref = null, ax = 0, az = 0;
      for (const b of items) {
        let uh = b.uh;
        if (ref && uh.x * ref.x + uh.z * ref.z < 0) uh = { x: -uh.x, y: 0, z: -uh.z };
        if (!ref) ref = uh;
        ax += uh.x; az += uh.z;
      }
      const ml = Math.hypot(ax, az) || 1;
      ginfo.set(r, { count: items.length, center: { x: cx, z: cz }, meanU: { x: ax / ml, y: 0, z: az / ml } });
    }
    const minRank = ranks[0], maxRank = ranks[ranks.length - 1];

    // support graph: upper rests on lower if adjacent layer + footprint overlap
    const supports = new Map(), dependents = new Map();
    const byId = new Map(bs.map(b => [b.id, b]));
    for (const up of bs) {
      const sup = [];
      for (const low of bs) {
        if (low === up || low.layer >= up.layer) continue;
        if (up.layer - low.layer > 1.5) continue; // adjacent layers only
        const gap = Math.abs((up.y - CFG.H / 2) - (low.y + CFG.H / 2));
        if (gap > CFG.H * 1.2) continue;
        const area = footprintOverlap(up.rect, low.rect);
        if (area > 0.04 * CFG.L * CFG.W) sup.push({ low: low.id, area });
      }
      supports.set(up.id, sup);
      for (const s of sup) {
        if (!dependents.has(s.low)) dependents.set(s.low, []);
        dependents.get(s.low).push({ upper: up.id, area: s.area });
      }
    }

    // carried load flow top->bottom
    const totalMass = bs.length;
    const carried = new Map(bs.map(b => [b.id, 1]));
    for (const r of [...ranks].sort((a, b) => b - a)) {
      for (const b of groups.get(r)) {
        const load = carried.get(b.id);
        const sup = supports.get(b.id) || [];
        if (!sup.length) continue;
        const tot = sup.reduce((s, x) => s + x.area, 0) || 1;
        for (const s of sup) carried.set(s.low, (carried.get(s.low) || 1) + load * s.area / tot);
      }
    }

    // COM margin vs base footprint
    const com = { x: bs.reduce((s, b) => s + b.x, 0) / bs.length, z: bs.reduce((s, b) => s + b.z, 0) / bs.length };
    const baseItems = groups.get(minRank) || [];
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (const b of baseItems) {
      const r = b.rect;
      for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
        const px = r.cx + s1 * r.hx * r.ax + s2 * r.hz * r.bx;
        const pz = r.cz + s1 * r.hx * r.az + s2 * r.hz * r.bz;
        minx = Math.min(minx, px); maxx = Math.max(maxx, px);
        minz = Math.min(minz, pz); maxz = Math.max(maxz, pz);
      }
    }
    const baseCx = (minx + maxx) / 2, baseCz = (minz + maxz) / 2;
    const baseRx = Math.max(0.1, (maxx - minx) / 2), baseRz = Math.max(0.1, (maxz - minz) / 2);
    const margin = Math.min(baseRx - Math.abs(com.x - baseCx), baseRz - Math.abs(com.z - baseCz));
    const scale = 0.08 * Math.min(baseRx, baseRz);
    const globalRisk = clamp((scale - margin) / scale, 0, 1);

    // eligibility: below highest complete layer (Jenga rule)
    let highestComplete = -1;
    for (const r of ranks) {
      const items = groups.get(r).filter(b => b.inTower !== false && !b.isRemoved);
      if (items.length >= CFG.PER_LAYER) highestComplete = r;
    }
    // if no complete layer found, allow all but top
    const maxLegalRank = highestComplete >= 0 ? highestComplete : maxRank - 1;

    const results = [];
    for (const c of bs) {
      if (c.layer >= maxLegalRank || c.isPlaced) continue;
      const g = ginfo.get(c.layer), flags = [];
      let depRisk = 0, veto = null;
      const gcount = g ? g.count : 1;
      if (gcount <= 1) veto = 'LAST_IN_LAYER';

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

      const dists = (groups.get(c.layer) || []).map(b => Math.hypot(b.x - g.center.x, b.z - g.center.z)).sort((a, b) => a - b);
      const distC = Math.hypot(c.x - g.center.x, c.z - g.center.z);
      const isCenterBlock = gcount === CFG.PER_LAYER && dists.length && distC <= dists[0] + 1e-6;
      const policy = gcount === 1 ? 1.0 : gcount === 2 ? 0.80 : isCenterBlock ? 0.42 : 0.55;
      depRisk = Math.max(depRisk, policy * 0.5);

      // pose: tilt=0 always (grid), yaw misalignment vs layer mean, seat offset
      const yawAlign = Math.abs(c.uh.x * g.meanU.x + c.uh.z * g.meanU.z);
      const yawN = clamp((1 - yawAlign) / 0.35, 0, 1);
      const layerY = (groups.get(c.layer) || []).reduce((s, b) => s + b.y, 0) / Math.max(1, gcount);
      const seatN = clamp(Math.abs(c.y - layerY) / CFG.H / 0.75, 0, 1);
      const supCount = (supports.get(c.id) || []).length;
      const underN = clamp((2 - supCount) / 2, 0, 1);
      const poseN = Math.max(yawN, seatN, underN);

      // jam: path blockers + ortho
      const pathN = pathBlockers(c, bs);
      const orthoN = orthoDev(c, groups, ginfo, ranks);
      const lockN = lockScore(c, groups);
      const jamN = clamp(0.45 * pathN + 0.30 * lockN + 0.25 * orthoN, 0, 1);

      const heightN = maxLegalRank > minRank ? (maxLegalRank - c.layer) / (maxLegalRank - minRank) : 0.5;
      const dxc = c.x - com.x, dzc = c.z - com.z;
      const dl = Math.hypot(com.x - baseCx, com.z - baseCz) || 1;
      const dc = Math.hypot(dxc, dzc);
      const benefit = dc > 1e-6 ? (dxc * (com.x - baseCx) + dzc * (com.z - baseCz)) / (dc * dl) : 0;
      const leanN = Math.max(globalRisk * 0.8, clamp(-benefit, 0, 1) * 0.3);

      const loadShare = (carried.get(c.id) || 1) / totalMass;
      const loadN = clamp(loadShare / (1.05 / CFG.PER_LAYER), 0, 1);
      if (loadN > 0.75) flags.push('high load');
      if (supCount === 1) flags.push('single support below');
      if (gcount === 2) flags.push('2 left in layer');

      const risk = CFG.W_LOAD * loadN + CFG.W_DEP * depRisk + CFG.W_POSE * poseN +
                   CFG.W_JAM * jamN + CFG.W_HEIGHT * heightN + CFG.W_LEAN * leanN;
      const score = clamp(Math.round(100 * (1 - risk)), 0, 100);
      const dirs = pickDirs(c, bs);
      results.push({ id: c.id, layer: c.layer, index: c.index, score, flags, veto, dirs, x: c.x, y: c.y, z: c.z });
    }
    results.sort((a, b) => (a.veto ? 1 : 0) - (b.veto ? 1 : 0) || b.score - a.score);
    return { results, layers: ranks.length, comOutside: margin < 0 };
  }

  function pathBlockers(c, blocks) {
    let best = 99;
    for (const sgn of [1, -1]) {
      const dx = c.uh.x * sgn, dz = c.uh.z * sgn;
      let count = 0;
      for (const o of blocks) {
        if (o.id === c.id || o.layer !== c.layer) continue;
        const rx = o.x - c.x, rz = o.z - c.z;
        const along = rx * dx + rz * dz;
        const perp = Math.abs(rx * -dz + rz * dx);
        if (along > CFG.W * 0.4 && along < CFG.L + CFG.W && perp < CFG.W * 0.9) count++;
      }
      best = Math.min(best, count);
    }
    return clamp(best / 3, 0, 1);
  }
  function orthoDev(c, groups, ginfo, ranks) {
    let err = 0, n = 0;
    const gi = ginfo.get(c.layer);
    for (const dl of [-1, 1]) {
      const og = ginfo.get(c.layer + dl);
      if (!og || !og.meanU) continue;
      const d = Math.abs(c.uh.x * og.meanU.x + c.uh.z * og.meanU.z);
      err += d; n++;
    }
    return n ? clamp((err / n) / 0.5, 0, 1) : 0;
  }
  function lockScore(c, groups) {
    const items = groups.get(c.layer) || [];
    let m = 0;
    for (const o of items) {
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
        if (o.id === c.id || o.layer !== c.layer) continue;
        const rx = o.x - c.x, rz = o.z - c.z;
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

  // === SELECTION-BASED HIGHLIGHT ===
  // R3F scene isn't reachable via fiber walk (separate reconciler root), but the
  // game's own selectBlock(id) action natively highlights a block (isSelected +
  // dims same-layer siblings via isHighlighted). It's local-only state — no
  // socket traffic — and doubles as "pre-select for Pull Block".
  let suggestedId = null;   // id we auto-selected
  let pendingSel = null;    // {id, t} — selectBlock reflects in snapshot ~1s late

  function trySelect(s, id) {
    try { s.selectBlock(id); return true; } catch (e) { return false; }
  }

  // === HUD ===
  const hud = document.createElement('div');
  hud.id = 'ja-hud';
  hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(10,14,20,.88);color:#cfe3ff;font:12px/1.45 monospace;padding:10px 12px;border-radius:8px;border:1px solid #2a4a6a;pointer-events:none;max-width:320px;white-space:pre-wrap;';
  let lastKey = '', lastTop = null, lastResult = null;

  function inGame(s) {
    return s && s.gamePhase === 'playing' && s.isMyTurn && !s.isCollapsing && !s.winner;
  }

  function update() {
    if (!hud.isConnected) document.documentElement.appendChild(hud);
    const s = findStore();
    if (!s || !Array.isArray(s.blocks)) { hud.textContent = 'JENGA ASSIST 3D\nwaiting for game…'; return; }
    const active = inGame(s);

    // resolve pending selection / detect user override
    if (pendingSel) {
      if (s.selectedBlock === pendingSel.id || Date.now() - pendingSel.t > 3000) pendingSel = null;
    }
    if (s.selectedBlock === suggestedId) { /* our suggestion still showing */ }
    else if (s.selectedBlock && s.selectedBlock !== suggestedId) suggestedId = null; // user picked manually
    if (s.selectedBlock == null && suggestedId) suggestedId = null;

    const key = s.blocks.length + '|' + (s.gamePhase || '') + '|' + (s.isMyTurn ? 1 : 0) + '|' +
                (s.currentTurn || '') + '|' + (s.selectedBlock || '') + '|' +
                s.blocks.map(b => b.isRemoved ? 'x' : (b.isPlaced ? 'p' : '.')).join('') +
                '|' + s.blocks.map(b => Math.round((b.x || 0) * 20) + ',' + Math.round((b.z || 0) * 20) + ',' + Math.round((b.y || 0) * 20)).join(';');
    if (key !== lastKey) {
      lastKey = key;
      lastTop = null; lastResult = null;
      if (active) {
        try {
          lastResult = advise(s.blocks);
          lastTop = lastResult.results.filter(r => !r.veto).slice(0, CFG.TOP_N);
          if (CFG.DEBUG) console.log('JA3D', lastTop.map(t => `#${t.id}:${t.score}`).join(' '));
        } catch (e) { if (CFG.DEBUG) console.log('ja3d fail', e); hud.textContent = 'JENGA ASSIST 3D\nscoring error'; }
      }
    }
    if (active && lastTop && lastTop.length) renderHud(s, lastTop, lastResult);

    // auto-select best block as the game's native highlight — only when nothing
    // is selected (never fight a manual selection, never toggle-off our own)
    if (active && lastTop && lastTop.length && s.selectedBlock == null && !pendingSel) {
      const best = lastTop[0];
      if (trySelect(s, best.id)) { pendingSel = { id: best.id, t: Date.now() }; suggestedId = best.id; }
    }

    if (!active) {
      // clear our suggestion when turn/phase ends so it can't linger
      if (suggestedId && s.selectedBlock === suggestedId && typeof s.selectBlock === 'function') {
        try { s.selectBlock(null); } catch (e) {}
      }
      suggestedId = null; pendingSel = null;
      const ph = s.gamePhase || '';
      hud.textContent = ph === 'playing'
        ? 'JENGA ASSIST 3D\nopponent\'s turn'
        : `JENGA ASSIST 3D\n${ph}${s.winner ? ' — ' + s.winner : ''}`;
    }
  }

  function renderHud(s, top, adv) {
    if (!top || !top.length) { hud.textContent = 'JENGA ASSIST 3D\nno candidates'; return; }
    const b = top[0];
    hud.textContent = [
      'JENGA ASSIST 3D — your turn',
      `BEST: ${b.id} (layer ${b.layer}) — score ${b.score}`,
      b.flags.length ? 'flags: ' + b.flags.join(', ') : 'flags: none',
      '',
      ...top.map((r, i) => `${i + 1}. ${r.id} L${r.layer}  ${r.score}${r.veto ? ' VETO' : ''}`),
      '',
      adv.comOutside ? '!! tower leaning — all moves risky' : 'advisory only',
    ].join('\n');
  }

  function boot() {
    setInterval(update, CFG.POLL_MS);
    if (CFG.DEBUG) console.log('JENGA ASSIST 3D loaded');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
