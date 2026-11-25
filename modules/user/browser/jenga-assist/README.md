# JENGA ASSIST

Best-block advisor for **Jenga World Web** (itch.io) — the "C.A.A.S for Jenga".
Reads the live tower state from the game's internals and highlights the
safest block to extract, with a push-direction arrow and a score HUD.

## Install (Firefox + Tampermonkey)

1. Install the game: https://shyhumangames.itch.io/jenga-world-web (free, browser).
2. Tampermonkey must be installed in Firefox.
3. Open `jenga-assist.user.js` and drag it onto a Firefox tab, or paste into
   Tampermonkey → "Create a new script".
4. The script matches `https://html-classic.itch.zone/html/20431350/*` —
   the game iframe. Tampermonkey runs in iframes by default; if it doesn't
   fire, enable "Run in iframes" isn't needed — just make sure the script is
   enabled and reload the game page.

## Use

- Works in **solo, local multiplayer, and online multiplayer**.
- In online mode it only shows advice on **your** turn (`canControl` gate).
- In local mode the HUD shows whose turn it is (`P1/P2 to move`).
- Green-tinted block = recommended extraction. Arrow = suggested push direction.
- HUD lists top-5 candidates with scores and risk flags (high load, moving,
  sole support above, tilted, VETO reasons).

## How it works

- Finds the game instance (`uM`) by walking the React fiber tree from the
  canvas's `__reactContainer` key — no game cooperation needed.
- Reads `world.snapshot()` (all 54 blocks: position, quaternion, layer, slot,
  sleeping) and `viewState()` (phase, turn, mode) every 400 ms.
- Scores candidates with a structural heuristic: contact-graph support
  analysis, carried-load flow, pose/jam/height/lean risk terms, vetoes for
  sole-support / last-in-layer / tilted blocks.
- Highlights via `scene.meshes[id]` (material is cloned first — block
  materials are shared).
- Read-only: never calls mutating game methods.

## Honest limits

This is a **heuristic advisor, not a physics oracle**. It cannot see stored
stress, friction, or wood variation — the "trembling block" problem. It will
usually pick a good block, but a-looking-safe block can still topple the
tower. Treat scores as relative ranking, not guarantees.

Basis: Wang et al. IROS'09 (robot Jenga planner), Kimura et al. (extraction
friction), Fazeli et al. arXiv:2505.09377 (contact-graph selection).

## Debug

Append `?ja_debug=1` to the game URL for console logging of scores.

---

## JENGA ASSIST 3D (jenga.space-z.ai port)

`jenga-assist-3d.user.js` — same heuristic advisor for https://jenga.space-z.ai (the server-room multiplayer version). Copy also at `~/jenga-assist-3d.user.js`.

Differences vs v1:
- Finds the Zustand store via React fiber walk; state snapshots are immutable so the tree is re-walked each poll (~400 ms)
- **Highlight uses the game's own `selectBlock(id)` action** — the R3F scene isn't reachable from userspace JS, but selecting a block natively highlights it (`isSelected`/`isHighlighted`) and pre-arms the "Pull Block" button. Local state only, no socket traffic, auto-cleared when your turn ends. If you click a different block yourself, the assistant won't override your choice
- Multiplayer gating via `isMyTurn` — only advises/selects on your turn; shows "opponent's turn" otherwise
- Works in real online rooms: create/join, ready up, play — no same-network needed

Same caveat: heuristic advisory, not a physics oracle (this game has no client physics at all — collapse is a server-side cosmetic animation).
