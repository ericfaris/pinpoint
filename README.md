# Triangulation

A real-time multiplayer web adaptation of the party game *Triangulation* (v1 —
in-person "Party Mode"). Players write one-word clues privately on their own
devices; guessing happens out loud in the room; shared game state is cast to a
TV via **Google Chromecast**.

> Live: https://games.mooseflip.com

## Architecture

A TypeScript monorepo (npm workspaces):

| Package | What |
|---|---|
| `@triangulation/shared` | Canonical game-state data model, wire protocol, and spectator-safe projection types. |
| `@triangulation/server` | Node + Socket.IO. Server-authoritative game engine (pure, deterministic), AI message generation (Anthropic) with a hybrid buffer + seed fallback, room registry. |
| `@triangulation/client` | React + Vite. Two builds from one codebase — the **player** UI (`index.html`) and the TV **receiver** UI (`receiver.html`). |

The server is the single source of truth. Clients send *intents*; the server
validates them against the engine and broadcasts spectator-safe projections —
hidden info (other Insiders' options, unflipped clue words) is never sent to
clients that shouldn't see it. The Chromecast receiver is just a read-only
WebSocket client rendering a TV-optimized view.

## Develop

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY
npm run dev            # server on :3001, client on :5173 (proxied)
```

Open http://localhost:5173. To host you need Chrome (for Google Cast); a
"Open TV view" fallback opens the receiver in a browser tab for local play
without a Chromecast.

## Test

```bash
npm test    # engine unit tests, full-game simulations, and WebSocket integration
```

The engine suite runs ~150 full-game simulations across every player count
(3–8), both modes, and luck extremes, asserting invariants and the
spectator-safe rule after every mutation.

## Build & run (production)

```bash
npm run build
node packages/server/dist/index.js   # serves client + Socket.IO on $PORT
```

Or `docker build -t triangulation . && docker run -p 3001:3001 --env-file .env triangulation`.

## Environment

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | AI message generation (falls back to bundled seed cards if unset). |
| `ANTHROPIC_MODEL` | Generation model (default `claude-haiku-4-5`). |
| `PORT` | HTTP/WebSocket port (default 3001). |
| `CAST_RECEIVER_APP_ID` | Google Cast custom receiver app id. |
| `PUBLIC_BASE_URL` | Base URL used to build the QR join link shown on the TV. |
