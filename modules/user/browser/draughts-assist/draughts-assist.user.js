// ==UserScript==
// @name         DRAUGHTS ASSIST — engine analysis for draughts.io
// @namespace    draughts-assist
// @version      0.2.0
// @description  Tracks your draughts.io game via WebSocket, sends positions to the site's own analysis engine worker, and shows best moves as board arrows + HUD. Advisory only — you still play the moves.
// @match        https://draughts.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ============================================================
 * DRAUGHTS ASSIST
 *
 * Architecture:
 *  - Wraps window.WebSocket (document-start) and observes the app's
 *    JSON protocol: start / move / time_update / game_resumed / game_over.
 *  - Maintains an 8x8/10x10 board locally. Captures come free in the
 *    `move` payload (`data.captured`), promotions inferred by back rank.
 *  - Converts the position to the site's own engine-state JSON format
 *    and queries draughts/analysis-worker.js (their hint engine) for a
 *    multi-PV ranked move list.
 *  - HUD shows the best move as board coordinates.
 *
 * Advisory only — never sends moves, never touches game state.
 * ========================================================== */

(function () {
  'use strict';

  const CFG = {
    ANALYSIS_URL: '/draughts/analysis-worker.js',
    ENGINE_URL: '/draughts/engine-worker.js',
    USE_ANALYSIS: true,          // analysis worker (multi-PV) vs engine worker (single best)
    DIFFICULTY: new URLSearchParams(location.search).get('da_diff') || 'grandmaster',
    DEPTH: 10,                   // analysis depth (app uses 17 for hints w/ 300s budget)
    BUDGET_MS: 3000,             // max think time per position
    DEBOUNCE_MS: 600,            // wait after last board change before analyzing
    POLL_MS: 500,
    ARROWS_N: 2,                 // how many candidate moves get arrows (1 = best only)
    DEBUG: new URLSearchParams(location.search).has('da_debug'),
  };

  // ==================== GAME STATE ====================
  // board[r][c]: null | {s:0|1 (0=white,1=black), k:0|1 (0=man,1=king), id:int}
  const G = {
    active: false,
    variant: null,
    myColor: null,          // 'white'|'black'
    turn: null,             // side to move
    size: 8,
    board: null,
    roomId: null,
    over: false,
    lastMove: null,         // {from:[r,c], to:[r,c], captured:[[r,c]..]}
    ply: 0,
    kingId: 1,
  };

  // Exact initial positions captured from live game_resumed boards[0]
  // (row-major strings, '.'=empty 'b'=black man 'w'=white man)
  const STD8 =
    '.b.b.b.b' + 'b.b.b.b.' + '.b.b.b.b' + '........' + '........' +
    'w.w.w.w.' + '.w.w.w.w' + 'w.w.w.w.';
  const EVEN8 =
    'b.b.b.b.' + '.b.b.b.b' + 'b.b.b.b.' + '........' + '........' +
    '.w.w.w.w' + 'w.w.w.w.' + '.w.w.w.w';
  const STD10 =
    '.b.b.b.b.b' + 'b.b.b.b.b.' + '.b.b.b.b.b' + 'b.b.b.b.b.' + '..........' + '..........' +
    '.w.w.w.w.w' + 'w.w.w.w.w.' + '.w.w.w.w.w' + 'w.w.w.w.w.';

  const VARIANTS = {
    russian8:       { setup: STD8,  first: 'white' },
    brazilian8:     { setup: STD8,  first: 'white' },
    podavki8:       { setup: STD8,  first: 'white' },
    english8:       { setup: STD8,  first: 'black', flying: true },
    fogOfWar8:      { setup: STD8,  first: 'black', flying: true },
    italian8:       { setup: EVEN8, first: 'white', flying: true },
    portuguese8:    { setup: EVEN8, first: 'white' },
    thai8:          { setup: '.b.b.b.b' + 'b.b.b.b.' + '........' + '........' + '........' + '........' + '.w.w.w.w' + 'w.w.w.w.', first: 'black' },
    turkish8:       { setup: '........' + 'bbbbbbbb' + 'bbbbbbbb' + '........' + '........' + 'wwwwwwww' + 'wwwwwwww' + '........', first: 'white' },
    international10:{ setup: STD10, first: 'white' },
    frisian10:      { setup: STD10, first: 'white' },
  };

  function initBoard(variant) {
    const v = VARIANTS[variant] || VARIANTS.russian8;
    const size = Math.round(Math.sqrt(v.setup.length));
    const b = Array.from({ length: size }, () => Array(size).fill(null));
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) {
        const ch = v.setup[r * size + c];
        if (ch === 'b') b[r][c] = { s: 1, k: 0, id: 0 };
        else if (ch === 'w') b[r][c] = { s: 0, k: 0, id: 0 };
      }
    return b;
  }

  function other(color) { return color === 'white' ? 'black' : 'white'; }
  function colorIdx(color) { return color === 'white' ? 0 : 1; }

  function applyMove(mv) {
    const { from, to, player } = mv;
    if (!G.board || !from || !to) return;
    const piece = G.board[from.row]?.[from.col];
    if (!piece) return;
    const capturedSq = [];
    // captureRoute: flat int array. Men (and non-flying kings): [capR,capC,...] pairs.
    // Flying-king variants: groups of 4 = (legFromR,legFromC,legToR,legToC) per capture leg.
    const route = Array.isArray(mv.captureRoute) ? mv.captureRoute : null;
    const flying = piece.k && (VARIANTS[G.variant] || {}).flying;
    if (route && route.length) {
      if (flying && route.length % 4 === 0) {
        for (let i = 0; i < route.length; i += 4) {
          const fr = route[i], fc = route[i + 1], tr = route[i + 2], tc = route[i + 3];
          // captured piece = first opponent piece on the ray legFrom -> legTo
          const dr = Math.sign(tr - fr), dc = Math.sign(tc - fc);
          for (let r = fr + dr, c = fc + dc; r !== tr || c !== tc; r += dr, c += dc) {
            const q = G.board[r]?.[c];
            if (q) { if (q.s !== piece.s) capturedSq.push([r, c]); break; }
          }
        }
      } else {
        for (let i = 0; i + 1 < route.length; i += 2) capturedSq.push([route[i], route[i + 1]]);
      }
    } else if (Array.isArray(mv.captured)) {
      // fallback: some payloads may carry explicit captured squares
      for (const cap of mv.captured) capturedSq.push([cap.row ?? cap[0], cap.col ?? cap[1]]);
    }
    for (const [cr, cc] of capturedSq) if (G.board[cr]) G.board[cr][cc] = null;
    G.board[from.row][from.col] = null;
    // promotion: man reaching the far edge rank
    const size = G.size;
    let king = piece.k;
    if (!king) {
      const edge = piece.s === 0 ? 0 : size - 1; // white->row0, black->row(size-1)
      if (to.row === edge) { king = 1; piece.id = G.kingId++; }
    }
    G.board[to.row][to.col] = { s: piece.s, k: king, id: piece.id };
    G.lastMove = {
      from: [from.row, from.col], to: [to.row, to.col],
      captured: capturedSq,
    };
    G.ply++;
    G.turn = other(player || G.turn || 'white');
  }

  function boardFromSnapshot(boards) {
    // boards: array of snapshots, each a flat array or rows; cells "w","W","b","B","1"-"6"
    const last = boards[boards.length - 1];
    if (!last) return null;
    // boards[i] is a flat row-major STRING of length size² ("w","W","b","B","1"-"6")
    const flat = typeof last === 'string' ? last
      : (Array.isArray(last) && typeof last[0] === 'string' ? last.join('') : null);
    const size = Math.round(Math.sqrt(flat ? flat.length : (last.length || 0) * (last[0]?.length || 0)));
    const cell = (r, c) => {
      const v = flat ? flat[r * size + c] : last[r][c];
      if (v == null) return null;
      const ch = String(v);
      if (ch === 'w' || ch === 'W') return { s: 0, k: ch === 'W' ? 1 : 0, id: 0 };
      if (ch === 'b' || ch === 'B') return { s: 1, k: ch === 'B' ? 1 : 0, id: 0 };
      // numbered kings "1"-"6"
      const n = parseInt(ch, 10);
      if (!isNaN(n)) return { s: n <= 3 ? 0 : 1, k: 1, id: n };
      return null;
    };
    const b = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => cell(r, c)));
    return { b, size };
  }

  // ==================== WS INTERCEPT ====================
  function handleFrame(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const t = msg.type;
    try {
      if (t === 'start') {
        G.active = true; G.over = false; G.ply = 0; G.lastMove = null; G.kingId = 1;
        G.variant = msg.variant || 'russian8';
        G.myColor = msg.color || null;
        G.size = Math.round(Math.sqrt((VARIANTS[G.variant] || VARIANTS.russian8).setup.length));
        G.board = initBoard(G.variant);
        G.turn = (VARIANTS[G.variant] || {}).first || 'white';
        G.roomId = msg.roomId || null;
        onGameChange('start');
      } else if (t === 'move' && msg.data) {
        if (!G.active || G.over) return;
        G.roomId = msg.roomId || G.roomId;
        applyMove(msg.data);
        onGameChange('move');
      } else if (t === 'game_resumed') {
        const snap = boardFromSnapshot(msg.boards || msg.data?.boards || []);
        if (snap) {
          G.board = snap.b; G.size = snap.size || msg.boardSize || G.size;
          G.variant = msg.variant || G.variant;
          G.myColor = msg.color || msg.playerColor || G.myColor;
          G.turn = msg.currentPlayer || G.turn;
          G.roomId = msg.roomId || G.roomId;
          G.active = true;
          G.over = !!(msg.result && msg.result !== 'ongoing');
          onGameChange('resume');
        }
      } else if (t === 'game_over' || t === 'opponent_surrendered' || t === 'draw_declined') {
        G.over = true; G.active = false;
        onGameChange('over');
      } else if (t === 'invalid_move') {
        // our tracked state may have desynced — flag for resync
        if (CFG.DEBUG) console.log('[da] invalid_move seen', msg);
      }
    } catch (e) { if (CFG.DEBUG) console.log('[da] frame error', e, raw.slice(0, 200)); }
  }

  function installWsHook() {
    const WS = window.WebSocket;
    if (!WS || WS.__daPatched) return;
    WS.__daPatched = true;
    // Prototype-level patching: catches sockets created BEFORE this script ran
    // (qutebrowser greasemonkey may inject late). Wraps 'message' listeners
    // however the app registers them.
    const tap = fn => function (ev) {
      try { if (typeof ev.data === 'string') handleFrame(ev.data); } catch (e) {}
      return fn.call(this, ev);
    };
    const origAdd = WS.prototype.addEventListener;
    WS.prototype.addEventListener = function (type, fn, opts) {
      if (type === 'message' && typeof fn === 'function')
        return origAdd.call(this, type, tap(fn), opts);
      return origAdd.call(this, type, fn, opts);
    };
    // trap `ws.onmessage = fn` assignments
    const origAddMsg = origAdd;
    try {
      Object.defineProperty(WS.prototype, 'onmessage', {
        configurable: true,
        get() { return this.__daOnMsg; },
        set(fn) {
          this.__daOnMsg = fn;
          if (typeof fn === 'function') origAddMsg.call(this, 'message', tap(fn));
        },
      });
    } catch (e) {}
  }

  // ==================== ENGINE STATE (d5o format) ====================
  function toEngineState() {
    const board = G.board.map(row => row.map(p =>
      p ? [p.s, p.k, p.id || 0] : null
    ));
    const st = {
      v: 1,
      board,
      turn: G.turn || 'white',
      result: 'ongoing',
      variant: G.variant || 'russian8',
      customRules: null,
      capturing: false,
      selectedRow: null, selectedCol: null,
      forcedCaptures: [],
      kingMoves: 0,
      endgameCounter: 0,
      maxEndgameMoves: 20,
      positionHistory: {},
      gameMode: 'humanVsOnline',
      aiPlayer: null,
      lastFromRow: G.lastMove ? G.lastMove.from[0] : null,
      lastFromCol: G.lastMove ? G.lastMove.from[1] : null,
      lastToRow: G.lastMove ? G.lastMove.to[0] : null,
      lastToCol: G.lastMove ? G.lastMove.to[1] : null,
      lastCapture: G.lastMove && G.lastMove.captured.length ? G.lastMove.captured.flat() : null,
      duckRow: null, duckCol: null, duckPlacement: false, duckCapture: false,
      duckBefore: null, duckAfter: null,
    };
    return st;
  }

  // ==================== ANALYSIS WORKER ====================
  const Eng = {
    worker: null, ready: false, busy: false, reqId: 0,
    pending: null, lastResult: null, lastStateKey: '', error: null,
    ensure() {
      if (this.worker) return;
      try {
        this.worker = new Worker(CFG.ANALYSIS_URL);
        this.worker.onmessage = ev => this.onMsg(ev.data);
        this.worker.onerror = ev => { this.error = 'worker error: ' + (ev.message || 'unknown'); if (CFG.DEBUG) console.log('[da]', this.error); };
      } catch (e) { this.error = 'worker spawn failed: ' + e; }
    },
    init(myColor) {
      this.ensure();
      if (!this.worker) return;
      if (this.ready && this.initColor === myColor) return;
      this.initColor = myColor || 'white';
      this.ready = false; this.lastResult = null; this.lastStateKey = '';
      this.worker.postMessage(JSON.stringify({ v: 1, type: 'init', id: 0, difficulty: CFG.DIFFICULTY, player: this.initColor, randomSeed: null }));
    },
    reinit() {
      this.ready = false; this.initColor = null; this.lastResult = null; this.lastStateKey = '';
      if (G.myColor) this.init(G.myColor);
    },
    onMsg(raw) {
      // worker protocol is JSON strings, not objects
      let d = raw;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
      if (!d || typeof d !== 'object') return;
      if (d.type === 'ready') { this.ready = true; this.error = null; return; }
      if (d.type === 'result' && this.pending !== null && d.id === this.pending) {
        this.pending = null; this.busy = false; this.lastResult = d.result; this.error = null;
        onAnalysis(this.lastResult);
        return;
      }
      if (d.type === 'error') {
        this.pending = null; this.busy = false; this.error = 'engine: ' + (d.error || 'unknown');
        if (CFG.DEBUG) console.log('[da] engine error', d);
      }
    },
    analyze(state) {
      if (!this.worker || !this.ready || this.busy) return false;
      const key = JSON.stringify(state.board) + state.turn;
      if (key === this.lastStateKey && this.lastResult) return false;
      this.lastStateKey = key;
      this.busy = true;
      const id = ++this.reqId;
      this.pending = id;
      this.worker.postMessage(JSON.stringify({
        v: 1, type: 'analyze', id, state,
        depth: CFG.DEPTH, stability: false, budgetMs: CFG.BUDGET_MS,
        purpose: 'liveAssistance',
      }));
      return true;
    },
  };

  // ==================== ARROW OVERLAY ====================
  const overlay = document.createElement('canvas');
  overlay.id = 'da-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const octx = overlay.getContext('2d');

  let boardRect = null; // {x,y,w,h} viewport px covering the full N×N grid
  try { const s = JSON.parse(localStorage.getItem('da_board_rect') || 'null'); if (s && s.w > 50) boardRect = s; } catch (e) {}
  let calibrating = false;
  const calPts = [];

  // screen mapping: the app rotates the board 180° for black, identity for white
  function mapRC(r, c) {
    const n = G.size || 8;
    return G.myColor === 'black' ? [n - 1 - r, n - 1 - c] : [r, c];
  }
  function sqCenter(r, c) {
    const n = G.size || 8;
    const [dr, dc] = mapRC(r, c);
    return { x: boardRect.x + (dc + 0.5) * boardRect.w / n, y: boardRect.y + (dr + 0.5) * boardRect.h / n };
  }

  function drawArrows() {
    if (!overlay.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const W = innerWidth, H = innerHeight;
    if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
      overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
    }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);
    if (!boardRect || !currentMoves || !currentMoves.length) return;
    if (G.over || G.turn !== G.myColor || !G.active) return;
    const n = G.size || 8;
    const cell = Math.min(boardRect.w, boardRect.h) / n;
    currentMoves.slice(0, CFG.ARROWS_N).forEach((m, i) => {
      const mv = m && m.move;
      if (!Array.isArray(mv) || mv.length < 4) return;
      const a = sqCenter(mv[0], mv[1]), b = sqCenter(mv[2], mv[3]);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const inset = cell * 0.34;
      const sx = a.x + dx / len * inset, sy = a.y + dy / len * inset;
      const ex = b.x - dx / len * inset, ey = b.y - dy / len * inset;
      const main = i === 0;
      const col = main ? '#ffffff' : '#999999';
      octx.globalAlpha = main ? 0.03 : 0.015;
      octx.strokeStyle = col; octx.fillStyle = col;
      octx.lineWidth = main ? 1.6 : 1.3;
      octx.lineCap = 'round';
      octx.beginPath(); octx.moveTo(sx, sy); octx.lineTo(ex, ey); octx.stroke();
      const ang = Math.atan2(ey - sy, ex - sx), hs = cell * 0.30;
      octx.beginPath();
      octx.moveTo(ex, ey);
      octx.lineTo(ex - hs * Math.cos(ang - 0.45), ey - hs * Math.sin(ang - 0.45));
      octx.lineTo(ex - hs * Math.cos(ang + 0.45), ey - hs * Math.sin(ang + 0.45));
      octx.closePath(); octx.fill();
      // captured squares (move tail: either [r,c] pairs or flat r,c ints)
      const tail = mv.slice(4);
      const caps = Array.isArray(tail[0]) ? tail : (() => { const o = []; for (let k = 0; k + 1 < tail.length; k += 2) o.push([tail[k], tail[k + 1]]); return o; })();
      octx.beginPath();
      for (const cp of caps) { const p = sqCenter(cp[0], cp[1]); octx.move(cp.x, cp.y); octx.arc(p.x, p.y, cell * 0.13, 0, 7); }
      octx.fill();
      octx.globalAlpha = 1;
    });
  }

  // ==================== CALIBRATION (press B, click 2 board corners) ====================
  const calHint = document.createElement('div');
  calHint.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(10,14,20,.92);color:#fff;font:13px monospace;padding:8px 16px;border-radius:8px;display:none;pointer-events:none;white-space:nowrap;';
  function setCalHint(t) { calHint.textContent = t || ''; calHint.style.display = t ? 'block' : 'none'; }

  function startCalibrate() {
    calibrating = true; calPts.length = 0;
    overlay.style.pointerEvents = 'auto';
    setCalHint('DRAUGHTS ASSIST — click top-left corner of the board');
  }
  function stopCalibrate() {
    calibrating = false; calPts.length = 0;
    overlay.style.pointerEvents = 'none';
    setCalHint('');
    drawArrows();
  }
  overlay.addEventListener('click', e => {
    if (!calibrating) return;
    calPts.push([e.clientX, e.clientY]);
    if (calPts.length === 1) { setCalHint('click bottom-right corner of the board'); return; }
    const [x1, y1] = calPts[0], [x2, y2] = calPts[1];
    boardRect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    try { localStorage.setItem('da_board_rect', JSON.stringify(boardRect)); } catch (err) {}
    stopCalibrate();
  });
  window.addEventListener('keydown', e => {
    if (e.key === 'b' || e.key === 'B') { calibrating ? stopCalibrate() : startCalibrate(); }
    else if (e.key === 'Escape' && calibrating) stopCalibrate();
  });

  let lastAnalysisAt = 0, analyzeTimer = null;
  let currentMoves = null;

  function sqName(r, c) {
    // display coords match the on-screen board orientation
    const [dr, dc] = mapRC(r, c);
    return `${dr},${dc}`;
  }
  function moveText(mv) {
    if (!mv || !Array.isArray(mv) || mv.length < 4) return '?';
    const cap = mv.length > 4 ? ' +capture' : '';
    return `${sqName(mv[0], mv[1])} → ${sqName(mv[2], mv[3])}${cap}`;
  }

  function onAnalysis(result) {
    currentMoves = result && Array.isArray(result.moves) ? result.moves : null;
    lastAnalysisAt = Date.now();
    drawArrows();
    if (CFG.DEBUG && currentMoves) console.log('[da] moves', currentMoves.map(m => moveText(m.move) + ':' + (m.score?.toFixed?.(0) ?? m.score)).join(' | '));
  }

  function onGameChange(why) {
    currentMoves = null;
    Eng.lastResult = null;
    drawArrows();
    if (G.active && !G.over && G.myColor) Eng.init(G.myColor);
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => {
      if (!G.active || G.over || G.turn !== G.myColor || !G.board) return;
      try { Eng.analyze(toEngineState()); } catch (e) { Eng.error = String(e); }
    }, CFG.DEBOUNCE_MS);
  }

  // ==================== BOOT ====================
  function boot() {
    installWsHook();
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(calHint);
    window.addEventListener('resize', drawArrows);
    setInterval(() => {
      drawArrows();
      // kick analysis when it's our turn and nothing is scheduled/in-flight
      const wantAnalyze = G.active && !G.over && G.turn === G.myColor && G.board && Eng.ready && !Eng.busy;
      if (wantAnalyze && !analyzeTimer && !Eng.lastResult) {
        analyzeTimer = setTimeout(() => {
          analyzeTimer = null;
          if (!G.active || G.over || G.turn !== G.myColor || !G.board) return;
          try { Eng.analyze(toEngineState()); } catch (e) { Eng.error = String(e); }
        }, CFG.DEBOUNCE_MS);
      } else if (!wantAnalyze && analyzeTimer) {
        clearTimeout(analyzeTimer); analyzeTimer = null;
      }
    }, CFG.POLL_MS);
    console.log('[da] DRAUGHTS ASSIST loaded');
    if (CFG.DEBUG) window.__da = { G, Eng, toEngineState, handleFrame };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
