// engine.test.js — Node tests for the C.A.A.S draughts engine.
// Extracts the ENGINE IIFE from caas.user.js and exercises it.
// Run: node engine.test.js   (no browser needed)

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'caas.user.js'), 'utf8');

// --- stubs the engine expects from userscript globals ---
// Site-verified playable squares: (r+c) % 2 === 1, row-major -> 32 squares
const SQ_MAP = [];
for (let r = 0; r < 8; r++)
  for (let c = 0; c < 8; c++)
    if ((r + c) % 2 === 1) SQ_MAP.push({ r, c });
if (SQ_MAP.length !== 32) throw new Error('bad SQ_MAP');
const CAAS = { ENGINE_DEPTH: 8, ENGINE_TIME_MS: 4000 };

// extract "const ENGINE = (() => { ... })();"
const m = src.match(/const ENGINE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
if (!m) { console.error('ENGINE block not found'); process.exit(1); }
const ENGINE = eval('(' + m[0].replace(/^const ENGINE = /, '').replace(/;$/, '') + ')');

// helpers ------------------------------------------------------------
const rc = (r, c) => SQ_MAP.findIndex(s => s.r === r && s.c === c);
const EMPTY = new Array(32).fill(null);
function board(pieces) { // pieces: {sqIdx: code} code 1=R man 2=R king 3=B man 4=B king
  const b = EMPTY.slice();
  for (const [i, v] of Object.entries(pieces)) b[i] = v;
  return b;
}
const startPos = () => {
  const b = EMPTY.slice();
  // black men rows 0-2 (dark squares), red men rows 5-7
  for (let i = 0; i < 32; i++) {
    const { r } = SQ_MAP[i];
    if (r <= 2) b[i] = 3;
    else if (r >= 5) b[i] = 1;
  }
  return b;
};
const engMoves = (b32, side) => ENGINE.allMoves(ENGINE.toEngine(b32), side === 'red' ? 1 : -1);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + e.message); }
}
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b)); }
function ok(c, msg) { if (!c) throw new Error(msg); }

// -------------------------------------------------------------------
console.log('C.A.A.S engine tests\n');

test('initial position: 7 legal red moves, no jumps', () => {
  const b = startPos();
  const mv = engMoves(b, 'red');
  eq(mv.length, 7, 'red move count');
  ok(mv.every(m => m.path.length === 2 && !m.caps.length), 'all quiet 1-step');
});

test('initial position: black also has 7 moves', () => {
  eq(engMoves(startPos(), 'black').length, 7, 'black move count');
});

test('forced jump: jump is the ONLY legal move', () => {
  // red man r5c2 jumps black man r4c3, lands r3c4
  const red = rc(5, 2), blk = rc(4, 3), land = rc(3, 4);
  ok(red >= 0 && blk >= 0 && land >= 0, 'squares playable');
  const b = EMPTY.slice();
  b[red] = 1; b[blk] = 3;
  const mv = engMoves(b, 'red');
  eq(mv.length, 1, 'only the jump');
  eq(mv[0].path.length, 2, 'path has origin+landing');
  eq(mv[0].path[0], [5, 2], 'from r5c2');
  eq(mv[0].path[1], [3, 4], 'to r3c4');
  ok(mv[0].caps.length === 1, 'one capture');
});

test('multi-jump: single piece chains two captures', () => {
  // red man r6c1 -> jump r5c2 land r4c3 -> jump r3c4 land r2c5
  const a = rc(6, 1), j1 = rc(5, 2), l1 = rc(4, 3), j2 = rc(3, 4), l2 = rc(2, 5);
  ok(a >= 0 && j1 >= 0 && l1 >= 0 && j2 >= 0 && l2 >= 0, 'all squares playable');
  const b = EMPTY.slice();
  b[a] = 1; b[j1] = 3; b[j2] = 3;
  const mv = engMoves(b, 'red');
  const dbl = mv.find(m => m.path.length === 3);
  ok(dbl, 'a 3-point (double jump) move exists, got path lengths: ' + JSON.stringify(mv.map(m => m.path.length)));
  ok(dbl.caps.length === 2, 'two captures');
});

test('man promotion: reaching back row crowns and stops', () => {
  // black man one step from promotion must become king
  const b = EMPTY.slice();
  // black man at r1c0? black moves DOWN (dr=+1), promotes r7. Place black man r6c1 -> moves to r7? r7c0/r7c2? 
  // simpler: red man at r1 -> promotes moving to r0
  const red = rc(1, 0), land = rc(0, 1);
  b[red] = 1;
  const nb32 = ENGINE.applyMove ? null : null;
  // use engine internals via a quiet move application: applyMove works on eng board
  const eng = ENGINE.toEngine(b);
  const mv = ENGINE.allMoves(eng, 1).find(m => m.path[1][0] === 0);
  ok(mv, 'promotion move exists');
  const after = ENGINE.applyMove(eng, mv);
  ok(after[0 * 8 + 1] === 2, 'red king on r0c1');
});

test('king moves backward (all 4 dirs)', () => {
  const b = EMPTY.slice();
  const k = rc(4, 3); // (4+3)=7 odd, playable
  ok(k >= 0, 'square playable');
  b[k] = 2; // red king
  const mv = engMoves(b, 'red');
  ok(mv.length >= 4, 'king has >=4 moves, got ' + mv.length);
  // verify a backward move exists: landing on r5 (below king)
  ok(mv.some(m => m.path[1][0] === 5), 'king can move backward');
});

test('no legal moves -> findBest reports no-moves', () => {
  // black to move but only red pieces? give black zero pieces and red blocked:
  const b = EMPTY.slice();
  b[rc(0, 1)] = 1; // lone red man top row, red to... ask black: black has no pieces
  const res = ENGINE.findBest(b, 'black');
  eq(res.note, 'no-moves', 'note');
});

test('findBest returns a legal move from startpos', () => {
  const res = ENGINE.findBest(startPos(), 'red');
  ok(res.path.length >= 2, 'path returned');
  ok(res.depth > 0, 'searched depth ' + res.depth);
  ok(Number.isFinite(res.eval), 'eval finite');
});

test('winning position: engine prefers capture', () => {
  // red can capture black man -> eval should be positive for red
  const red = rc(5, 2), blk = rc(4, 3), land = rc(3, 4);
  const b = EMPTY.slice();
  b[red] = 1; b[blk] = 3;
  const res = ENGINE.findBest(b, 'red');
  ok(res.eval > 0, 'eval positive after winning capture, got ' + res.eval);
});

test('kings are worth more than men in eval', () => {
  const b1 = EMPTY.slice(); b1[rc(4, 3)] = 1;         // lone red man
  const b2 = EMPTY.slice(); b2[rc(4, 3)] = 2;         // lone red king
  ok(ENGINE.evalBoard(ENGINE.toEngine(b2), 1) > ENGINE.evalBoard(ENGINE.toEngine(b1), 1), 'king > man');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
