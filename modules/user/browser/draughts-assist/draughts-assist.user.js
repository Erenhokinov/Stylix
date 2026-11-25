// ==UserScript==
// @name         DRAUGHTS ASSIST — engine analysis for draughts.io
// @namespace    draughts-assist
// @version      0.1.0
// @description  Tracks your draughts.io game via WebSocket, sends positions to the site's own analysis engine worker, and shows the best moves in a HUD. Advisory only — you still play the moves.
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
    DIFFICULTY: 'grandmaster',
    DEPTH: 10,                   // analysis depth (app uses 17 for hints w/ 300s budget)
    BUDGET_MS: 3000,             // max think time per position
    DEBOUNCE_MS: 600,            // wait after last board change before analyzing
    POLL_MS: 500,
    TOP_N: 4,
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

  const VARIANTS = {
    russian8:       { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    english8:       { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    italian8:       { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    brazilian8:     { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    portuguese8:    { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    podavki8:       { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    turkish8:       { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    thai8:          { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    international10:{ size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    frisian10:      { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    b3g8:           { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    b3g10:          { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    german8:        { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    czech8:         { size: 8,  rows: [[0,2,'b'],[5,7,'w']], first: 'white' },
    canadian10:     { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    french10:       { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    italian10:      { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    english10:      { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    brazilian10:    { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    portuguese10:   { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
    japanese10:     { size: 10, rows: [[0,3,'b'],[6,9,'w']], first: 'white' },
  };

  function initBoard(variant) {
    const v = VARIANTS[variant] || VARIANTS.russian8;
    const size = v.size;
    const b = Array.from({ length: size }, () => Array(size).fill(null));
    for (const [r0, r1, color] of v.rows) {
      const s = color === 'w' ? 0 : 1;
      for (let r = r0; r <= r1; r++)
        for (let c = 0; c < size; c++)
          if ((r + c) % 2 === 1) b[r][c] = { s, k: 0, id: 0 };
    }
    return b;
  }

  function other(color) { return color === 'white' ? 'black' : 'white'; }
  function colorIdx(color) { return color === 'white' ? 0 : 1; }

  function applyMove(mv) {
    const { from, to, player, captured } = mv;
    if (!G.board || !from || !to) return;
    const piece = G.board[from.row]?.[from.col];
    if (!piece) return;
    // remove captured pieces (server gives exact squares)
    if (Array.isArray(captured)) {
      for (const cap of captured) {
        const cr = cap.row ?? cap[0], cc = cap.col ?? cap[1];
        if (G.board[cr]) G.board[cr][cc] = null;
      }
    }
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
      captured: Array.isArray(captured) ? captured.map(c => [c.row ?? c[0], c.col ?? c[1]]) : [],
    };
    G.ply++;
    G.turn = other(player || G.turn || 'white');
  }

  function boardFromSnapshot(boards) {
    // boards: array of snapshots, each a flat array or rows; cells "w","W","b","B","1"-"6"
    const last = boards[boards.length - 1];
    if (!last) return null;
    const flat = Array.isArray(last) && typeof last[0] === 'string' ? last : null;
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
        G.size = (VARIANTS[G.variant] || VARIANTS.russian8).size;
        G.board = initBoard(G.variant);
        G.turn = (VARIANTS[G.variant] || {}).first || 'white';
        G.roomId = msg.roomId || null;
        onGameChange('start');
      } else if (t === 'move' && msg.data) {
        if (!G.active || G.over) return;
        G.roomId = msg.roomId || G.roomId;
        applyMove(msg.data);
        onGameChange('move');
      } else if (t === 'time_update' && msg.currentPlayer) {
        if (G.active && !G.over && msg.currentPlayer !== G.turn) {
          G.turn = msg.currentPlayer;
          onGameChange('clock');
        }
      } else if (t === 'game_resumed') {
        const snap = boardFromSnapshot(msg.boards || msg.data?.boards || []);
        if (snap) {
          G.board = snap.b; G.size = snap.size;
          G.turn = msg.currentPlayer || G.turn;
          G.roomId = msg.roomId || G.roomId;
          G.active = true; G.over = false;
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
    if (!WS || WS.__daWrapped) return;
    class Wrapped extends WS {
      constructor(...args) {
        super(...args);
        try { this.addEventListener('message', ev => { if (typeof ev.data === 'string') handleFrame(ev.data); }); } catch (e) {}
      }
    }
    Wrapped.__daWrapped = true;
    window.WebSocket = Wrapped;
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

  // ==================== HUD ====================
  const hud = document.createElement('div');
  hud.id = 'da-hud';
  hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:rgba(10,14,20,.88);color:#cfe3ff;font:12px/1.5 monospace;padding:10px 12px;border-radius:8px;border:1px solid #2a6a4a;pointer-events:none;max-width:340px;white-space:pre-wrap;';

  let lastHudKey = '', lastAnalysisAt = 0, analyzeTimer = null;
  let currentMoves = null;

  function sqName(r, c) { return `${r},${c}`; }
  function moveText(mv) {
    if (!mv || !Array.isArray(mv) || mv.length < 4) return '?';
    const cap = mv.length > 4 ? ' +capture' : '';
    return `${sqName(mv[0], mv[1])} → ${sqName(mv[2], mv[3])}${cap}`;
  }

  function renderHud() {
    let txt;
    if (!G.active && !G.over) { txt = 'DRAUGHTS ASSIST\nwaiting for game…'; }
    else if (G.over) { txt = 'DRAUGHTS ASSIST\ngame over'; }
    else {
      const myTurn = G.turn === G.myColor;
      const head = `DRAUGHTS ASSIST — ${G.variant || ''}\n${myTurn ? 'YOUR TURN' : "opponent's turn"} (${G.turn || '?'})`;
      if (!myTurn) { txt = head; }
      else if (Eng.busy || !currentMoves) {
        txt = head + '\n\nanalyzing…';
      } else {
        const lines = currentMoves.slice(0, CFG.TOP_N).map((m, i) =>
          `${i + 1}. ${moveText(m.move)}  (${typeof m.score === 'number' ? m.score.toFixed(0) : '?'})`
        );
        txt = head + '\nBEST: ' + moveText(currentMoves[0].move) + '\n\n' + lines.join('\n') +
              (Eng.error ? '\n! ' + Eng.error : '');
      }
    }
    if (txt !== lastHudKey) { lastHudKey = txt; hud.textContent = txt; }
  }

  function onAnalysis(result) {
    currentMoves = result && Array.isArray(result.moves) ? result.moves : null;
    lastAnalysisAt = Date.now();
    lastHudKey = '';
    renderHud();
    if (CFG.DEBUG && currentMoves) console.log('[da] moves', currentMoves.map(m => moveText(m.move) + ':' + (m.score?.toFixed?.(0) ?? m.score)).join(' | '));
  }

  function onGameChange(why) {
    currentMoves = null;
    Eng.lastResult = null;
    lastHudKey = '';
    if (!hud.isConnected) document.documentElement.appendChild(hud);
    renderHud();
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
    setInterval(() => {
      if (!hud.isConnected) document.documentElement.appendChild(hud);
      renderHud();
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
    if (CFG.DEBUG) {
      console.log('[da] DRAUGHTS ASSIST loaded');
      window.__da = { G, Eng, toEngineState, handleFrame };
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
