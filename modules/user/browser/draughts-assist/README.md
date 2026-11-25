# DRAUGHTS ASSIST — draughts.io

Browser userscript that gives engine-strength move suggestions on
https://draughts.io — live human games (quick match / rooms).

## Features

- **Board arrows only** — no HUD. Best move = faint white arrow, 2nd =
  faint gray (`ARROWS_N` configurable). Captured squares get dots.
- Passive: hooks `WebSocket` and watches the site's protocol — it never
  sends moves or touches game state.

## How it works

- Wraps `window.WebSocket` at document-start, reconstructs the board from
  `start` / `move` (`captureRoute` flat-int encoding, incl. flying-king
  4-int legs) / `game_resumed` (decodes `boards[]` snapshot strings).
- Converts to the site's internal "d5o" state format and queries the site's
  own `analysis-worker.js` (`purpose:"liveAssistance"`) — the same engine
  behind the site's hint feature.

## Install

- **Firefox**: Tampermonkey → new script → paste `draughts-assist.user.js`.
- **qutebrowser**: wired via `programs.qutebrowser.greasemonkey` in
  `qutebrowser.nix` (home-manager switch + restart).

## Board calibration (for arrows)

The site renders via Flutter canvas — no DOM squares — so arrow placement
needs a one-time calibration:

1. Press **B** on the keyboard.
2. Click the **top-left corner** of the board, then the **bottom-right
   corner** (Esc cancels).
3. Saved to `localStorage` — persists across sessions.

If the window is resized, press B and re-calibrate.

Orientation is automatic: white = identity, black = 180° rotation.

## Tunables (`CFG` at top of file)

- `DIFFICULTY` — fixed at `grandmaster`; override per-session with
  `?da_diff=easy|medium|hard|master|grandmaster|grossmeister|human`
- `DEPTH`, `BUDGET_MS`, `ARROWS_N` (arrow count)
- `?da_debug=1` in URL → console logs + `window.__da` handle

## Limitations

- Advisory only — you play the moves yourself.
- All real draughts.io variants supported with exact captured setups:
  russian8, brazilian8, podavki8, english8, fogOfWar8, italian8,
  portuguese8, thai8, turkish8, international10, frisian10.
- `duckCheckers8` / `custom_game` / `flick_checkers` are not tracked
  (duck state unsupported).
- If the protocol changes or tracking desyncs, reload the page — the app
  will re-send `game_resumed` with a full board snapshot which we decode.
- Server does NOT require our acks — the app's own client handles the
  `game_event_ack` protocol; we only listen.
