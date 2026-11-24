# C.A.A.S — Checkers Advanced Assistance System

Best-move arrows for [247checkers.com](https://www.247checkers.com) in
qutebrowser. A.C.A.S-style two-tab architecture: a pure-JS English draughts
(American checkers) engine runs in a second tab on the same origin, and the
game tab draws an arrow overlay showing the engine's top move.

## Files

- `caas.user.js` — the userscript (single file, no dependencies)
- `engine.test.js` — Node tests for the engine (`node engine.test.js`)

## Install

Copy `caas.user.js` to:

```
~/.config/qutebrowser/greasemonkey/caas.user.js
```

Restart qutebrowser (userscripts are loaded at startup).

## Usage

1. **Engine tab** — open `https://www.247checkers.com/#engine` in one tab.
   The URL hash selects engine mode. A small green status box
   (`C.A.A.S engine: ready`) appears top-right. Keep the tab open; it does
   not need to stay visible.
2. **Game tab** — open `https://www.247checkers.com/` in another tab and
   play. When it is your turn, a green arrow shows the engine's best move
   and a HUD (top-right of the board) shows eval + status.

> Tip: open the **game tab last** (or keep it focused). Hidden/background
> tabs get their timers throttled, which slows position updates.

## Protocol

Cross-tab comms use `BroadcastChannel("caas-checkers")` — same-origin, so it
works in qutebrowser where `GM_setValue`/`GM_getValue` are per-origin
localStorage and cannot share state across tabs.

- Game → Engine: `{type:"POSITION", id, squares[32], turn, playerColor, sqMap}`
- Engine → Game: `{type:"BEST_MOVE", id, path:[sq...], eval}`
- Engine also sends `{type:"ENGINE_READY"}` on startup.

Square encoding: 0=empty, 1=red man, 2=red king, 3=black man, 4=black king.
`path` is a list of 0–31 square indices (multi-jump = full sequence).

## Board extraction (how it works)

The game is a bundled IIFE; the board object is module-scoped and not
reachable from `window`. The script hooks `Array.prototype.push/unshift/
splice` at `document-start`; when the engine pushes the Gameplay Screen into
`screenManager._list`, the screen (and its `boardDisplay.board.grid`)
is captured. Turn is detected from `cellDisplays[].isMoveable` (pieces of
the side to move) with the score-panel turn rings as fallback.

Square→pixel mapping uses `boardDisplay.cellDisplays[i]` positions
transformed by `boardDisplay._wvp` (world→canvas matrix) — verified
empirically by synthetic clicks.

## Debugging

- `?caas_debug=1` — enables `[CAAS]` console logs and a grid overlay.
- `?caas_color=red|black` — force which side is "you" (default: auto/red).
  Click the HUD `color:` label to cycle auto → red → black.
- If the HUD says "waiting for engine…", the engine tab isn't open or
  hasn't loaded `#engine`.

## Known quirks

- **Player color**: auto-detection assumes you play red (bottom). If you
  play black, click the HUD color toggle or use `?caas_color=black`.
- **Online play**: board extraction works the same (same canvas engine),
  but player-color auto-detection may need the manual override.
- Suggestions only draw on **your** turn; they clear on opponent's turn.
- Engine strength: alpha-beta depth 8, ~1.2 s/move — strong club level,
  not world-class.
- The interstitial/ad screen after starting a game delays the first
  position read by a few seconds.
