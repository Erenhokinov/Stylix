# DRAUGHTS ASSIST — draughts.io

Browser userscript that gives engine-strength move suggestions on
https://draughts.io — works in live human games (quick match / rooms).

## How it works

- Hooks `window.WebSocket` (class wrapper, installed at document-start) and
  parses the site's own JSON protocol passively — it never sends anything.
- Reconstructs the board locally: `start` → initial setup, `move` → apply
  `{from,to,captured}` (handles promotions, captures, turn flips).
- Converts the position to the site's internal "d5o" state format and feeds
  it to **the site's own analysis worker**
  (`/draughts/analysis-worker.js`, spawned as a Web Worker with
  `purpose:"liveAssistance"`) — the same engine the site's hint feature uses.
- HUD (top-right) shows `YOUR TURN` / `opponent's turn`, then the top-N
  moves with scores once analysis returns (~1–3 s at depth 10).

## Install (Firefox + Tampermonkey)

1. Tampermonkey → new script → paste `draughts-assist.user.js`.
2. Play at https://draughts.io/play/ — HUD appears automatically.

## Tunables (top of file, `CFG`)

- `DIFFICULTY`: `easy|medium|hard|master|grandmaster|grossmeister|human`
- `DEPTH` / `BUDGET_MS`: analysis depth and think-time cap
- `TOP_N`: moves shown in HUD
- `?da_debug=1` in URL → console logs + `window.__da` introspection handle

## Notes / limitations

- Advisory only: it does NOT click for you — you still play the moves.
- Board tracking assumes standard setup + server-authoritative `move`
  messages; if the server changes protocol or sends an unhandled snapshot
  format, the HUD may desync (a page reload + `resume_game` flow is the
  recovery path).
- Multi-step captures rely on the server's `captured` square list.
- `game_resumed` snapshot parsing is best-effort.
- Only tested against Russian 8x8; other variants share the same move
  protocol and should work (setup tables included for common variants).
