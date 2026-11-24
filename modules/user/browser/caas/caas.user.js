// ==UserScript==
// @name         C.A.A.S — Checkers Advanced Assistance System
// @namespace    caas-checkers
// @version      0.1.0
// @description  Best-move arrows for 247checkers.com — two-tab arch, pure JS engine
// @match        https://www.247checkers.com/*
// @match        https://247checkers.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/* ============================================================
   C.A.A.S — Checkers Advanced Assistance System
   Two-tab architecture:
     Tab 1 (#engine): runs the draughts engine, answers POSITION msgs
     Tab 2 (game):    reads live board, draws best-move arrows
   Comms: BroadcastChannel 'caas-checkers' (same-origin, qutebrowser-safe)
   ============================================================ */

'use strict';

// === CONFIG ===
const CAAS = {
  CHANNEL: 'caas-checkers',
  ENGINE_DEPTH: 8,          // alpha-beta depth (plies)
  ENGINE_TIME_MS: 1200,     // max think time per position
  POLL_MS: 400,             // board poll interval (game tab)
  SEND_MIN_INTERVAL: 250,   // min ms between POSITION sends
  DEBUG: /[?&]caas_debug=1/.test(location.search) || location.hash.includes('debug'),
  // board rect calibration (fractions of canvas w/h) — tune with ?caas_debug=1
  BOARD: { x: 0.04, y: 0.04, w: 0.92, h: 0.92 },
};

const isEngineMode = /engine/i.test(location.hash) || /[?&]caas_engine=1/.test(location.search);

// === LOG ===
const log = (...a) => { if (CAAS.DEBUG) console.log('[CAAS]', ...a); };
const warn = (...a) => console.warn('[CAAS]', ...a);

// ============================================================
// === BOARD EXTRACTION ===
// The game is a bundled IIFE — board objects are module-scoped and
// NOT reachable from window (verified by heap analysis + BFS).
// The ONLY reliable live-ref path: hook Array mutators at
// document-start. The ScreenManager does `this._list.push(screen)`
// when a screen is added — the Gameplay Screen carries
// .boardDisplay.board (Ki) -> .grid (8x8 Ji cells) -> .piece (ji).
// ============================================================

const G = window.__caas = window.__caas || {
  screen: null,       // Gameplay Screen object
  board: null,        // Ki board object
  screens: [],        // debug: all pushed screens (name -> obj)
  hooked: false,
  candidates: [],     // debug: objects that looked board-ish
};
// mirror to real window for debugging/interop (userscript sandbox
// proxies window writes into a shadow object)
try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.__caas = G; } catch (e) {}

function looksLikeGameplayScreen(o) {
  try {
    return o && typeof o === 'object' &&
      (o.name === 'Gameplay Screen' ||
       (o.boardDisplay && o.boardDisplay.board && o.boardDisplay.board.grid));
  } catch (e) { return false; }
}

function adoptScreen(o) {
  try {
    const bd = o.boardDisplay;
    const b = bd && bd.board;
    if (b && b.grid && Array.isArray(b.grid)) {
      G.screen = o; G.board = b;
      log('board adopted:', b.grid.length, 'x', b.grid[0] && b.grid[0].length);
      return true;
    }
  } catch (e) {}
  return false;
}

function scanPushed(args) {
  for (const a of args) {
    if (looksLikeGameplayScreen(a)) { adoptScreen(a); return; }
    // record every screen-ish object for debugging
    try {
      if (a && typeof a === 'object' && typeof a.name === 'string' && a.name.length < 60 &&
          (a.screenManager || a._display || a.boardDisplay) && G.screens.length < 40 &&
          !G.screens.some(s => s.obj === a)) {
        G.screens.push({ name: a.name, obj: a });
        log('screen seen:', a.name);
      }
    } catch (e) {}
    // also: arrays of screens?
    if (Array.isArray(a)) for (const x of a) if (looksLikeGameplayScreen(x)) { adoptScreen(x); return; }
  }
}

function installArrayHooks() {
  if (G.hooked) return; G.hooked = true;
  const methods = ['push', 'unshift', 'splice'];
  for (const m of methods) {
    const orig = Array.prototype[m];
    Array.prototype[m] = function (...args) {
      const r = orig.apply(this, args);
      try {
        if (!G.board) {
          if (m === 'splice') scanPushed(args.slice(2)); else scanPushed(args);
        }
      } catch (e) {}
      return r;
    };
  }
  log('array hooks installed');
}
installArrayHooks();

// Fallback: even if push never fires with the screen (e.g. screen
// added before our hook — impossible at document-start, but be safe),
// poll for any reachable object via known debug hook.
setInterval(() => {
  if (G.board) return;
  try {
    const d = window['247gamesdebug'];
    // dumpScreens proves B._instance exists but doesn't expose it;
    // nothing else to try here — the array hook is the real path.
  } catch (e) {}
}, 2000);

// ============================================================
// === POSITION SERIALIZER ===
// grid[row][col] -> Ji cell { piece: ji|null, isValid: bool }
// ji piece { isKing: bool, ...color fields... }
// We map playable cells row-major -> 32 squares (0..31).
// ============================================================

// Cached mapping built on first read: list of {r,c} playable cells
let SQ_MAP = null;         // [{r,c}] length 32, row-major order
let DARK_PARITY = null;    // which (r+c)%2 is playable, detected

function buildSquareMap(grid) {
  const cells = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = grid[r] && grid[r][c];
      if (!cell) continue;
      // isValid on the CELL likely marks a playable (dark) square —
      // verify: count must be 32
      if (cell.isValid === true || cell.isValid === 1) {
        cells.push({ r, c });
      }
    }
  }
  if (cells.length === 32) { SQ_MAP = cells; DARK_PARITY = null; return true; }

  // fallback: parity detection — find parity shared by cells that
  // currently hold pieces or are flagged; default even
  for (const par of [0, 1]) {
    const cand = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
      if (((r + c) % 2) === par) cand.push({ r, c });
    // playable side should contain pieces at game start; can't know
    // mid-game, so use isValid count heuristic first (done above).
  }
  // last resort: assume even parity
  SQ_MAP = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
    if (((r + c) % 2) === 0) SQ_MAP.push({ r, c });
  DARK_PARITY = 0;
  return SQ_MAP.length === 32;
}

// color probe: returns 'red'|'black'|null
// Verified live: piece.team is a NUMBER — 0 = bottom/red, 1 = top/black
function pieceColor(p) {
  if (!p) return null;
  if (typeof p.team === 'number') return p.team === 0 ? 'red' : 'black';
  if (p.team === 'red' || p.team === 'Red') return 'red';
  if (p.team === 'black' || p.team === 'Black') return 'black';
  const cands = [p.color, p._color, p.isRed, p.isBlack, p.side];
  for (const v of cands) {
    if (v == null) continue;
    if (v === 'red' || v === 'Red' || v === 1 || v === true && p.isRed) {
      if (v === true && !('isRed' in p)) continue;
      return 'red';
    }
    if (v === 'black' || v === 'Black' || v === 2 || v === -1) return 'black';
    if (typeof v === 'string' && /red|light/i.test(v)) return 'red';
    if (typeof v === 'string' && /black|dark/i.test(v)) return 'black';
  }
  // object refs?
  for (const k of ['player','team','owner','side']) {
    const v = p[k];
    if (v && typeof v === 'object') {
      for (const kk of Object.keys(v)) {
        const vv = v[kk];
        if (vv === 'red' || vv === 'Red') return 'red';
        if (vv === 'black' || vv === 'Black') return 'black';
      }
    }
  }
  return null;
}

function readPosition() {
  const b = G.board;
  if (!b || !b.grid) return null;
  const grid = b.grid;
  if (!buildSquareMap(grid)) return null;

  const squares = new Array(32).fill(null);
  let redCount = 0, blackCount = 0, unknownColor = 0;
  for (let i = 0; i < 32; i++) {
    const { r, c } = SQ_MAP[i];
    const cell = grid[r] && grid[r][c];
    const p = cell && cell.piece;
    if (!p) continue;
    const col = pieceColor(p);
    const isKing = !!(p.isKing || p.king || p.isCrowned || p.crowned);
    if (col === 'red') { squares[i] = isKing ? 2 : 1; redCount++; }
    else if (col === 'black') { squares[i] = isKing ? 4 : 3; blackCount++; }
    else { squares[i] = isKing ? -2 : -1; unknownColor++; }
    if (CAAS.DEBUG && col === null) {
      log('piece color unknown, keys:', Object.keys(p).slice(0, 30));
    }
  }
  return { squares, redCount, blackCount, unknownColor };
}

// Turn detection: the score panel display object holds
// topTurnRing (black/top) and bottomTurnRing (red/bottom);
// whichever .visible === true is the side to move.
let turnPanel = null;
function findTurnPanel() {
  if (turnPanel) return turnPanel;
  // The score panel is NOT a descendant of the Gameplay Screen — it is a
  // child of a shared ancestor (verified live: screen.parent.parent.parent
  // ._children[1] holds topTurnRing/bottomTurnRing). Walk UP the parent
  // chain and scan each ancestor's _children.
  const seen = new Set();
  const check = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return null;
    seen.add(o);
    try {
      if (o.topTurnRing && o.bottomTurnRing) return o;
      const kids = o._children || o.children;
      if (Array.isArray(kids)) for (const k of kids) {
        const r = check(k); if (r) return r;
      }
    } catch (e) {}
    return null;
  };
  let p = G.screen;
  for (let i = 0; i < 8 && p; i++) {
    const hit = check(p);
    if (hit) { turnPanel = hit; return hit; }
    // also scan siblings at this level
    const par = p.parent;
    if (par && Array.isArray(par._children)) {
      for (const k of par._children) {
        if (k === p || seen.has(k)) continue;
        const hit2 = check(k);
        if (hit2) { turnPanel = hit2; return hit2; }
      }
    }
    p = par;
  }
  return null;
}

function detectTurnAndColor() {
  const res = { turn: null, playerColor: null, candidates: [] };
  // PRIMARY: cellDisplays.isMoveable marks cells of the side to move —
  // the piece's team field gives the turn directly (verified live).
  try {
    const bd = G.screen && (G.screen.boardDisplay || (G.screen.obj && G.screen.obj.boardDisplay));
    const cds = bd && bd.cellDisplays;
    if (cds) {
      for (const d of cds) {
        if (d && d.isMoveable && d.cell && d.cell.piece) {
          const t = d.cell.piece.team;
          if (t === 0 || t === '0') { res.turn = 'red'; break; }
          if (t === 1 || t === '1') { res.turn = 'black'; break; }
        }
      }
      if (res.turn) res.candidates.push('isMoveable team->' + res.turn);
    }
  } catch (e) {}
  // ring fallback only if isMoveable gave nothing (a wrong/duplicate
  // panel could otherwise override the correct turn)
  if (!res.turn) {
    const p = findTurnPanel();
    if (p) {
      try {
        const top = !!p.topTurnRing.visible, bot = !!p.bottomTurnRing.visible;
        if (top !== bot) res.turn = bot ? 'red' : 'black';
        res.candidates.push(`turnRing top=${top} bot=${bot}`);
      } catch (e) {}
    }
  }
  if (!res.playerColor) res.playerColor = 'red';
  return res;
}

// ============================================================
// === DRAUGHTS ENGINE (English/American checkers) ===
// Board: array[32], 0=empty, 1=red man, 2=red king, 3=black man, 4=black king
// Red moves toward index-decreasing rows... defined by SQ_MAP:
// row 0 is TOP of board. Red (bottom) moves row+1? NO — verify:
// Red starts rows 5-7 and moves UP (toward row 0) => dr=-1.
// Black starts rows 0-2, moves DOWN => dr=+1.
// Kings move all 4 diagonal dirs, ONE step (American checkers).
// Forced jumps, multi-jump same piece, promotion ends turn mid-jump
// (American rule: if a man is crowned during a jump sequence it stops).
// ============================================================

const ENGINE = (() => {
  // eng board: Int8Array(64), idx r*8+c
  //  0 empty | +1 red man | +2 red king | -1 black man | -2 black king
  const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
  let PLAYABLE = null; // Set of r*8+c built from SQ_MAP
  let playableSrc = null;

  function ensurePlayable() {
    if (PLAYABLE && playableSrc === SQ_MAP) return;
    playableSrc = SQ_MAP;
    PLAYABLE = SQ_MAP ? new Set(SQ_MAP.map(s => s.r * 8 + s.c)) : null;
  }
  const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const playable = (r, c) => PLAYABLE ? PLAYABLE.has(r * 8 + c) : (((r + c) & 1) === 1);
  const side = v => v > 0 ? 1 : -1;
  const isKing = v => Math.abs(v) === 2;
  const manDir = v => v > 0 ? -1 : 1; // red (bottom) moves up, black down

  function toEngine(sq32) {
    ensurePlayable();
    const b = new Int8Array(64);
    for (let i = 0; i < 32; i++) {
      const v = sq32[i]; if (!v) continue;
      const { r, c } = SQ_MAP[i];
      // 1 red man, 2 red king, 3 black man, 4 black king; negatives = unknown color -> skip
      const eng = v === 1 ? 1 : v === 2 ? 2 : v === 3 ? -1 : v === 4 ? -2 : 0;
      b[r * 8 + c] = eng;
    }
    return b;
  }
  function rcToSq(r, c) {
    for (let i = 0; i < 32; i++) { const s = SQ_MAP[i]; if (s.r === r && s.c === c) return i; }
    return -1;
  }

  function hasJumpFrom(b, sd, r, c) {
    const v = b[r * 8 + c]; if (!v || side(v) !== sd) return false;
    const dirs = isKing(v) ? DIAG : DIAG.filter(d => d[0] === manDir(v));
    for (const [dr, dc] of dirs) {
      const r1 = r + dr, c1 = c + dc, r2 = r + 2 * dr, c2 = c + 2 * dc;
      if (!inB(r1, c1) || !inB(r2, c2)) continue;
      const mid = b[r1 * 8 + c1];
      if (mid && side(mid) !== sd && !b[r2 * 8 + c2] && playable(r2, c2)) return true;
    }
    return false;
  }

  // DFS: all complete jump sequences continuing from piece at (r,c).
  // accPath = landing squares so far (excluding origin). Returns [{path,caps}]
  function jumpPaths(b, sd, r, c, accPath, caps) {
    const piece = b[r * 8 + c];
    const dirs = isKing(piece) ? DIAG : DIAG.filter(d => d[0] === manDir(piece));
    const results = [];
    let any = false;
    for (const [dr, dc] of dirs) {
      const r1 = r + dr, c1 = c + dc, r2 = r + 2 * dr, c2 = c + 2 * dc;
      if (!inB(r1, c1) || !inB(r2, c2) || !playable(r2, c2)) continue;
      const mid = b[r1 * 8 + c1];
      if (!(mid && side(mid) !== sd && !b[r2 * 8 + c2])) continue;
      any = true;
      const promotes = !isKing(piece) && ((sd > 0 && r2 === 0) || (sd < 0 && r2 === 7));
      const nb = b.slice();
      nb[r1 * 8 + c1] = 0;
      nb[r * 8 + c] = 0;
      nb[r2 * 8 + c2] = promotes ? (sd > 0 ? 2 : -2) : piece;
      const newPath = [...accPath, [r2, c2]];
      if (promotes) results.push({ path: newPath, caps: [...caps, mid] });
      else results.push(...jumpPaths(nb, sd, r2, c2, newPath, [...caps, mid]));
    }
    if (!any) results.push({ path: accPath, caps });
    return results;
  }

  function allMoves(b, sd) {
    const moves = [];
    // jumps are forced — if any exist, ONLY jumps are legal
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const v = b[r * 8 + c];
      if (!v || side(v) !== sd || !hasJumpFrom(b, sd, r, c)) continue;
      const piece = v;
      const dirs = isKing(piece) ? DIAG : DIAG.filter(d => d[0] === manDir(piece));
      for (const [dr, dc] of dirs) {
        const r1 = r + dr, c1 = c + dc, r2 = r + 2 * dr, c2 = c + 2 * dc;
        if (!inB(r1, c1) || !inB(r2, c2) || !playable(r2, c2)) continue;
        const mid = b[r1 * 8 + c1];
        if (!(mid && side(mid) !== sd && !b[r2 * 8 + c2])) continue;
        const promotes = !isKing(piece) && ((sd > 0 && r2 === 0) || (sd < 0 && r2 === 7));
        const nb = b.slice();
        nb[r1 * 8 + c1] = 0; nb[r * 8 + c] = 0;
        nb[r2 * 8 + c2] = promotes ? (sd > 0 ? 2 : -2) : piece;
        const p0 = [[r2, c2]];
        if (promotes) moves.push({ path: [[r, c], ...p0], caps: [mid] });
        else for (const res of jumpPaths(nb, sd, r2, c2, p0, [mid]))
          moves.push({ path: [[r, c], ...res.path], caps: res.caps });
      }
    }
    if (moves.length) return moves;
    // quiet moves
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const v = b[r * 8 + c];
      if (!v || side(v) !== sd) continue;
      const dirs = isKing(v) ? DIAG : DIAG.filter(d => d[0] === manDir(v));
      for (const [dr, dc] of dirs) {
        const r1 = r + dr, c1 = c + dc;
        if (!inB(r1, c1) || !playable(r1, c1) || b[r1 * 8 + c1]) continue;
        const promotes = !isKing(v) && ((sd > 0 && r1 === 0) || (sd < 0 && r1 === 7));
        moves.push({ path: [[r, c], [r1, c1]], caps: [], promo: promotes });
      }
    }
    return moves;
  }

  function applyMove(b, mv) {
    const nb = b.slice();
    const path = mv.path;
    const [fr, fc] = path[0];
    const piece = nb[fr * 8 + fc];
    nb[fr * 8 + fc] = 0;
    for (let i = 1; i < path.length; i++) {
      const [pr, pc] = path[i - 1];
      const [cr, cc] = path[i];
      const mr = (pr + cr) / 2, mc = (pc + cc) / 2;
      if (Number.isInteger(mr) && Number.isInteger(mc)) nb[mr * 8 + mc] = 0;
    }
    const [lr, lc] = path[path.length - 1];
    const promotes = mv.promo !== undefined ? mv.promo
      : (!isKing(piece) && ((piece > 0 && lr === 0) || (piece < 0 && lr === 7)));
    nb[lr * 8 + lc] = promotes ? (piece > 0 ? 2 : -2) : piece;
    return nb;
  }

  function evalBoard(b, sd) {
    let score = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const v = b[r * 8 + c]; if (!v) continue;
      const s = side(v), king = isKing(v);
      let val = king ? 180 : 100;
      if (!king) {
        if (s > 0 && r === 7) val += 8;   // back rank guard
        if (s < 0 && r === 0) val += 8;
        val += s > 0 ? (7 - r) * 2 : r * 2; // advancement
      }
      const dc = Math.abs(3.5 - c), dr = Math.abs(3.5 - r);
      if (dc <= 1.5 && dr <= 1.5) val += 10; // center
      score += s === sd ? val : -val;
    }
    const mob = allMoves(b, sd).length - allMoves(b, -sd).length;
    return score + mob * 3;
  }

  function orderMoves(b, sd, moves) {
    return moves.map(mv => {
      let s = 0;
      if (mv.caps && mv.caps.length) s += 1000 * mv.caps.length;
      return { mv, s };
    }).sort((a, b2) => b2.s - a.s).map(x => x.mv);
  }

  let nodes = 0, deadline = 0;
  function negamax(b, sd, depth, alpha, beta, ply) {
    nodes++;
    if ((nodes & 2047) === 0 && Date.now() > deadline) throw 'timeout';
    if (depth === 0) return evalBoard(b, sd);
    const moves = allMoves(b, sd);
    if (!moves.length) {
      let pieces = 0;
      for (let i = 0; i < 64; i++) if (b[i]) pieces++;
      return pieces === 0 ? 0 : -100000 + ply;
    }
    const ordered = orderMoves(b, sd, moves);
    let best = -Infinity;
    for (const mv of ordered) {
      const sc = -negamax(applyMove(b, mv), -sd, depth - 1, -beta, -alpha, ply + 1);
      if (sc > best) best = sc;
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) break;
    }
    return best;
  }

  function findBest(sq32, sideToMove) {
    ensurePlayable();
    const b = toEngine(sq32);
    const sd = sideToMove === 'red' ? 1 : -1;
    const rootMoves = allMoves(b, sd);
    if (!rootMoves.length) return { path: [], eval: 0, note: 'no-moves', depth: 0, nodes: 0 };
    deadline = Date.now() + CAAS.ENGINE_TIME_MS;
    nodes = 0;
    let bestMv = rootMoves[0], bestScore = -Infinity, completedDepth = 0;
    for (let d = 1; d <= CAAS.ENGINE_DEPTH; d++) {
      try {
        let iterBest = null, iterScore = -Infinity, a = -Infinity;
        for (const mv of orderMoves(b, sd, rootMoves)) {
          const sc = -negamax(applyMove(b, mv), -sd, d - 1, -Infinity, -a, 1);
          if (sc > iterScore) { iterScore = sc; iterBest = mv; }
          if (sc > a) a = sc;
        }
        bestMv = iterBest; bestScore = iterScore; completedDepth = d;
      } catch (e) { if (e === 'timeout') break; throw e; }
      if (Date.now() > deadline) break;
    }
    const pathSq = bestMv.path.map(([r, c]) => rcToSq(r, c));
    return { path: pathSq, eval: bestScore, depth: completedDepth, nodes, rootMoves: rootMoves.length };
  }

  return { findBest, toEngine, allMoves, applyMove, evalBoard };
})();

// ============================================================
// === BROADCASTCHANNEL COMMS ===
// ============================================================
const chan = ('BroadcastChannel' in window) ? new BroadcastChannel(CAAS.CHANNEL) : null;

// ============================================================
// === ENGINE MODE ===
// ============================================================
function engineMain() {
  log('engine mode active, depth', CAAS.ENGINE_DEPTH);
  document.title = 'C.A.A.S Engine';
  const status = document.createElement('div');
  status.id = 'caas-engine-status';
  status.style.cssText = 'position:fixed;top:8px;right:8px;background:#111;color:#0f0;padding:6px 10px;font:12px monospace;z-index:99999;border:1px solid #0f0';
  status.textContent = 'C.A.A.S engine: ready';
  document.documentElement.appendChild(status);

  chan.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.type !== 'POSITION') return;
    try {
      // ensure SQ_MAP exists in engine tab too — it needs the mapping!
      // Game tab sends sqMap as [[r,c],...] arrays; normalize to {r,c}.
      if (m.sqMap && m.sqMap.length === 32) {
        SQ_MAP = m.sqMap.map(s => Array.isArray(s) ? { r: s[0], c: s[1] } : s);
      }
      if (!SQ_MAP) { log('no sqMap yet'); return; }
      const t0 = Date.now();
      const res = ENGINE.findBest(m.squares, m.turn || 'red');
      chan.postMessage({
        type: 'BEST_MOVE', id: m.id, path: res.path, eval: res.eval,
        depth: res.depth, nodes: res.nodes, ms: Date.now() - t0,
      });
      status.textContent = `C.A.A.S engine: d${res.depth} ${res.nodes}n ${Date.now()-t0}ms eval=${res.eval}`;
    } catch (e) {
      warn('engine error', e);
      chan.postMessage({ type: 'BEST_MOVE', id: m.id, path: [], eval: 0, error: String(e) });
    }
  };
  if (chan) chan.postMessage({ type: 'ENGINE_READY' });
}

// ============================================================
// === GAME MODE ===
// ============================================================
const GM = {
  lastSentSquares: '',
  lastSend: 0,
  pendingId: 0,
  bestPath: null,
  bestEval: null,
  engineSeen: false,
  engineWarnAt: 0,
  overlay: null,
  hud: null,
  playerColorOverride: null, // 'red'|'black'|null — set via HUD click or ?caas_color=
};

{
  const m = location.search.match(/[?&]caas_color=(red|black)/);
  if (m) GM.playerColorOverride = m[1];
}

function gameMain() {
  log('game mode active');
  setupOverlay();
  setupHud();
  if (chan) {
    chan.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'ENGINE_READY') { GM.engineSeen = true; updateHud(); }
      else if (m.type === 'BEST_MOVE' && m.id === GM.pendingId) {
        GM.bestPath = m.path && m.path.length ? m.path : null;
        GM.bestEval = m.eval;
        GM.engineSeen = true;
        updateHud();
        drawOverlay();
      }
    };
    chan.postMessage({ type: 'ENGINE_READY' }); // announce presence? (engine replies too; harmless)
  }
  setInterval(gameTick, CAAS.POLL_MS);
}

let lastPosHash = '';
function gameTick() {
  if (!G.board || !G.board.grid) return;
  const pos = readPosition();
  if (!pos) return;
  const det = detectTurnAndColor();
  if (CAAS.DEBUG && det.candidates.length) log('turn candidates:', det.candidates.slice(0, 10));

  const playerColor = GM.playerColorOverride || det.playerColor || guessPlayerColor(pos);
  const turn = det.turn || (playerColor === 'red' ? 'black' : 'red'); // fallback: opposite moves

  // hash position for change detection
  const hash = pos.squares.join(',') + '|' + turn;
  const now = Date.now();
  if (hash !== lastPosHash && now - GM.lastSend > CAAS.SEND_MIN_INTERVAL && chan) {
    lastPosHash = hash;
    GM.lastSend = now;
    GM.pendingId = now;
    chan.postMessage({
      type: 'POSITION', id: GM.pendingId,
      squares: pos.squares, turn,
      playerColor,
      sqMap: SQ_MAP.map(s => [s.r, s.c]),
    });
    if (!GM.engineSeen && now - GM.engineWarnAt > 5000) {
      GM.engineWarnAt = now;
      showToast('Engine not detected — open engine tab: 247checkers.com/#engine');
    }
  }

  // draw overlay only when it's the player's turn
  const myTurn = (turn === playerColor);
  if (!myTurn && GM.bestPath) { GM.bestPath = null; drawOverlay(); }
  updateHudText(playerColor, turn, det);
}

function guessPlayerColor(pos) {
  // Heuristic: player is 'red' if red pieces are on bottom rows (5-7)
  // i.e. red man squares with high index. Fallback 'red'.
  return 'red';
}

// ============================================================
// === OVERLAY ===
// ============================================================
function setupOverlay() {
  const ensure = () => {
    const gameCanvas = document.getElementById('app-player-game-canvas')
      || [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!gameCanvas || GM.overlay) return !!gameCanvas;
    const parent = gameCanvas.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    const ov = document.createElement('canvas');
    ov.id = 'caas-overlay';
    ov.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:9999';
    parent.appendChild(ov);
    GM.overlay = ov;
    GM.gameCanvas = gameCanvas;
    const ro = new ResizeObserver(() => { sizeOverlay(); drawOverlay(); });
    ro.observe(gameCanvas);
    sizeOverlay();
    log('overlay installed');
    return true;
  };
  if (!ensure()) {
    const t = setInterval(() => { if (ensure()) clearInterval(t); }, 1000);
  }
}

function sizeOverlay() {
  const c = GM.gameCanvas, o = GM.overlay;
  if (!c || !o) return;
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  o.width = Math.max(1, Math.round(r.width * dpr));
  o.height = Math.max(1, Math.round(r.height * dpr));
  o.style.width = r.width + 'px';
  o.style.height = r.height + 'px';
  GM.scaleX = o.width / c.width;   // canvas px -> overlay px
  GM.scaleY = o.height / c.height;
}

// preferred: use cellDisplays positions transformed to canvas px
// via boardDisplay._wvp (world->canvas transform, VERIFIED live by
// click test: selected the exact cell). _xformMatrix is unreliable
// (resets to identity between frames).
function squareCenter(i) {
  try {
    const bd = G.screen && (G.screen.boardDisplay || (G.screen.obj && G.screen.obj.boardDisplay));
    const cds = bd && bd.cellDisplays;
    const { r, c: col } = SQ_MAP[i];
    const d = cds && cds[r * 8 + col];
    const m = bd && (bd._wvp || bd._xformMatrix);
    if (d && m && d.x != null && d.y != null) {
      const A = m.a ?? m[0], D = m.d ?? m[3], TX = m.tx ?? m[4], TY = m.ty ?? m[5];
      if (A != null) {
        // _wvp maps board-local -> canvas px; add canvas CSS offset
        // is NOT needed: _wvp already yields canvas backing-store px.
        return { x: A * d.x + TX, y: D * d.y + TY };
      }
      return { x: d.x, y: d.y };
    }
  } catch (e) {}
  // fallback: heuristic board rect on the GAME canvas coordinate space
  const c = GM.gameCanvas;
  const W = c ? c.width : 800, H = c ? c.height : 800;
  const { r, c: col } = SQ_MAP[i];
  const bw = W * CAAS.BOARD.w, bh = H * CAAS.BOARD.h;
  const ox = W * CAAS.BOARD.x, oy = H * CAAS.BOARD.y;
  const sq = Math.min(bw, bh) / 8;
  return { x: ox + (col + 0.5) * sq, y: oy + (r + 0.5) * sq };
}

function drawOverlay() {
  const o = GM.overlay;
  if (!o || !SQ_MAP) return;
  const ctx = o.getContext('2d');
  ctx.clearRect(0, 0, o.width, o.height);
  if (CAAS.DEBUG) drawDebugGrid(ctx);
  const path = GM.bestPath;
  if (!path || path.length < 2) return;
  const pts = path.map(i => {
    const p = squareCenter(i);
    return { x: p.x * GM.scaleX, y: p.y * GM.scaleY };
  });
  // arrows
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const last = i === pts.length - 2;
    drawArrow(ctx, a, b, last ? 0.9 : 0.45);
  }
  // highlight final square
  const f = pts[pts.length - 1];
  const sq = estimateSqSize();
  ctx.fillStyle = 'rgba(0,255,136,0.18)';
  ctx.fillRect(f.x - sq / 2, f.y - sq / 2, sq, sq);
}

function estimateSqSize() {
  const c = GM.gameCanvas;
  const W = c ? c.width : 800, H = c ? c.height : 800;
  return (Math.min(W * CAAS.BOARD.w, H * CAAS.BOARD.h) / 8) * (GM.scaleX || 1);
}

function drawArrow(ctx, a, b, alpha) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const head = Math.min(22, len * 0.35);
  const tailX = b.x - ux * head, tailY = b.y - uy * head;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#00ff88';
  ctx.fillStyle = '#00ff88';
  ctx.lineWidth = Math.max(4, estimateSqSize() * 0.12);
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(tailX, tailY); ctx.stroke();
  // arrowhead
  const px = -uy, py = ux;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(tailX + px * head * 0.45, tailY + py * head * 0.45);
  ctx.lineTo(tailX - px * head * 0.45, tailY - py * head * 0.45);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawDebugGrid(ctx) {
  const c = GM.gameCanvas;
  if (!c || !SQ_MAP) return;
  const W = c.width, H = c.height;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,0,0,0.5)';
  ctx.lineWidth = 1;
  // board rect heuristic
  const bw = W * CAAS.BOARD.w, bh = H * CAAS.BOARD.h;
  const ox = W * CAAS.BOARD.x, oy = H * CAAS.BOARD.y;
  ctx.strokeRect(ox * GM.scaleX, oy * GM.scaleY, bw * GM.scaleX, bh * GM.scaleY);
  // square centers + indices
  ctx.fillStyle = 'rgba(255,255,0,0.9)';
  ctx.font = `${Math.max(8, 10 * GM.scaleX)}px monospace`;
  for (let i = 0; i < 32; i++) {
    const p = squareCenter(i);
    ctx.beginPath();
    ctx.arc(p.x * GM.scaleX, p.y * GM.scaleY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(String(i + 1), p.x * GM.scaleX + 4, p.y * GM.scaleY);
  }
  ctx.restore();
}

// ============================================================
// === HUD ===
// ============================================================
function setupHud() {
  const hud = document.createElement('div');
  hud.id = 'caas-hud';
  hud.style.cssText = 'position:fixed;top:8px;right:8px;background:rgba(0,0,0,0.75);color:#0f0;padding:8px 10px;font:12px/1.5 monospace;z-index:99999;border:1px solid #0f0;border-radius:4px;pointer-events:auto;user-select:none;min-width:170px';
  hud.innerHTML = '<div id="caas-hud-status">C.A.A.S …</div><div id="caas-hud-move"></div><div id="caas-hud-eval"></div><div id="caas-hud-color" style="cursor:pointer;text-decoration:underline">color: auto</div>';
  document.documentElement.appendChild(hud);
  GM.hud = hud;
  hud.querySelector('#caas-hud-color').onclick = () => {
    const order = [null, 'red', 'black'];
    const i = order.indexOf(GM.playerColorOverride);
    GM.playerColorOverride = order[(i + 1) % 3];
    updateHud();
  };
}
function updateHud() { updateHudText(); }
function updateHudText(playerColor, turn, det) {
  const s = GM.hud && GM.hud.querySelector('#caas-hud-status');
  const mv = GM.hud && GM.hud.querySelector('#caas-hud-move');
  const ev = GM.hud && GM.hud.querySelector('#caas-hud-eval');
  const col = GM.hud && GM.hud.querySelector('#caas-hud-color');
  if (s) {
    s.textContent = GM.engineSeen ? 'C.A.A.S: engine linked' : 'C.A.A.S: waiting for engine…';
    s.style.color = GM.engineSeen ? '#0f0' : '#ff0';
  }
  if (mv) {
    if (GM.bestPath && GM.bestPath.length >= 2) {
      const f = GM.bestPath[0] + 1, t = GM.bestPath[GM.bestPath.length - 1] + 1;
      mv.textContent = `Best: ${f}→${t}` + (GM.bestPath.length > 2 ? ` (${GM.bestPath.length - 1} jumps)` : '');
    } else mv.textContent = '';
  }
  if (ev) ev.textContent = GM.bestEval != null ? `eval ${GM.bestEval}` : '';
  if (col) col.textContent = `color: ${GM.playerColorOverride || 'auto'}`;
}
let toastEl = null;
function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#420;color:#ff0;padding:8px 14px;font:13px monospace;z-index:99999;border:1px solid #ff0;border-radius:4px';
    document.documentElement.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.remove(), 6000);
}

// ============================================================
// === INIT ===
// ============================================================
// document.documentElement is null at document-start — defer init
// until DOM is ready or engineMain/gameMain crash on appendChild.
const caasStart = () => { if (isEngineMode) engineMain(); else gameMain(); };
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', caasStart);
} else caasStart();
