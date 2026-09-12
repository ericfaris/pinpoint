# Bot harness — play a real game with automated players

Play a full Pinpoint game in your browser with 2–7 bot players filling the
other seats. Bots run as real socket clients against the running dev server;
you play your own turns in the browser like normal.

## Run it

```bash
npm run dev              # terminal 1 — server + client
npm run bots -- --open   # terminal 2 — 3 bots + auto-open both browser views
```

The harness prints a room code and two URLs (and with `--open`, launches them).
The room code **changes every run** — always use the one the current run printed.
Open **both** URLs in browser windows:

- **TV view** — `http://localhost:5173/receiver.html?code=XXXX` (put this on the big screen / second window)
- **You** — `http://localhost:5173/?code=XXXX` → enter your name → join

Pick any name **except** a bot's (Bishop / Rook / Knight) — a duplicate name is
rejected. Once you're in the lobby, press **ENTER** in the harness terminal to
start. Nothing happens until you do — the harness is the host.
The first bot ("Bishop") is the host and drives start / next round / rematch
automatically, so you never have to touch host controls. At game over you get
a `[r] rematch / [q] quit` prompt.

## What the bots do

| Situation | Bot behaviour |
|---|---|
| Bot is Insider, `WRITE_CLUES` | picks a random message, writes three themed one-word clues, transmits |
| Bot is the active Insider, guessing | waits a few seconds ("let the room talk"), flips a board, then records CORRECT / INCORRECT weighted by `--accuracy` |
| Bot is a guesser | nothing — guessing is verbal, you do it out loud |
| Between rounds / rematch | host bot advances automatically |

When **you** are the Insider, the harness does nothing — you pick the message,
write the clues, flip boards and record results yourself.

## Options

```
npm run bots -- --open            # open the player + TV views automatically
npm run bots -- --bots 2          # 2 bots → THREE_PLAYER mode (you + 2)
npm run bots -- --accuracy 0.9    # bots guess "right" 90% of the time
npm run bots -- --fast            # short delays, for quick iteration
npm run bots -- --humans 2        # wait for 2 people before offering start
npm run bots -- --url http://localhost:5173   # origin the bots connect through
npm run bots -- --help
```

## "I can't join"

- **Wrong code** — it changes every run; use the code the *current* terminal shows.
- **Name taken** — don't use a bot's name (Bishop / Rook / Knight).
- **Stale tab** — hard-refresh the player tab, or open a fresh window, so an old
  game's saved session doesn't linger.
- **Harness not running** — if it exited (you pressed `q`, or it crashed), the
  room is gone. Start it again for a new code.

`--url` should match whatever origin your browser uses. The default goes
through the Vite dev proxy, so it works even when the server port is remapped.
