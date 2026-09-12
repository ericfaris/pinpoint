# Pinpoint — Design System

**Theme: Cold War intelligence dossier.** Offset-printed on aging stock, stamped
in propaganda red, set in condensed government type. Every surface is a filed
document. Reference board: 1960s US propaganda posters + vintage spy board-game
box art (Microdot, Undercover, et al.).

Interactive reference (palette, type, icons, live components, audio):
<https://claude.ai/code/artifact/18c116a9-d5eb-477e-ac2c-25378ccdd7b3>

The canonical tokens live in
[`packages/client/src/common/styles.css`](../packages/client/src/common/styles.css).
This doc names and explains them; keep the two in sync.

## Palette

| Token | Hex | Role |
|---|---|---|
| `--bg` / `--paper` | `#E7DCB8` | Field ground (page) |
| `--panel` / `--paper-hi` | `#F2E9CD` | Filed document / card fill |
| `--bg-2` / `--paper-lo` | `#D9CAA0` | Shadowed stock |
| `--text` / `--ink` | `#241D12` | Printing ink — warm near-black |
| `--muted` / `--ink-soft` | `#6E5F45` | Faded carbon, secondary text |
| `--accent` | `#A3222C` | Propaganda red — accent, **Team A** |
| `--accent-2` | `#3C5568` | Federal blue — **Team B** |
| `--warn` / brass | `#B9911F` | Score tokens, hold/warning states only |
| `--good` | `#57692F` | Field olive — confirmations |

Two working inks (red + ink-black) over parchment; steel / brass / olive are
signals, not styling. Neutrals are warm — never a cold grey. Do not add a fourth
hue for decoration.

Category tags (`--cat-*`) extend the same family: C red, M steel, P brass,
L olive, B `#7A4C30`, W `#55415E`.

## Typography

Three roles:

All three are loaded from Google Fonts in `index.html` and `receiver.html`.

- **Display** — `var(--font-display)`: `"Kremlin Kommisar", "Oswald", Impact, "Arial Narrow", sans-serif`.
  Bundled *Kremlin Kommisar* first, **Oswald** as the web fallback. Uppercase,
  tracking .02–.06em. Headings, buttons, board words, TV brand.
- **Body** — `var(--font-body)`: `"Domine", Georgia, serif`. 17px / 1.6, max ~66ch.
  Rules copy, descriptions, prose. `body` default.
- **Data** — `var(--font-data)`: `"Space Mono", "Courier New", monospace`.
  Tracking .06–.12em. Pills, timers, join codes (`.codebox` / `.code-big`).

## Components

Built from the app CSS — 2px ink borders, 4px radius, hard offset "stamp" shadow
(`--stamp-shadow: 3px 3px 0 rgba(36,29,18,.35)`), press-to-translate feedback.
No blur, no float, no gradient fills.

- **Buttons**: `.primary` (red), `.good` (olive), `.bad` (red), `.ghost`. Active
  state translates `2px, 2px`.
- **Pills / tags**: 2px border, uppercase, 999px radius.
- **Score tokens**: outlined stars, `.on` fills brass with a soft glow.
- **Clue board**: 0.5s Y-axis flip, `cubic-bezier(.45,.05,.15,1)`; face-down is a
  45° ink hatch, face-up is panel stock.
- **Team crests**: stamped badge medallions stand in for "Team A / Team B" labels.

## Iconography

Flat, two-color, bold geometric line weight, filed on a plate. Red is for
emphasis only. See `assets/icon-plate.webp` for the reference set (crosshair,
transmitter, dossier, loupe, redaction bar, fingerprint, rotary dial, target dot,
tripod, agent, wax seal, telegraph key).

## Voice & copy

In character everywhere the player reads:

| Say | Not |
|---|---|
| Transmit | Submit |
| Round opens | Round starts |
| Intel compromised | Wrong |
| Agent / operative | Player |
| Case file | Game |

## Audio dispatches (TV / receiver)

Handler voice over radio static, all under 6s. Voice: **Jeff Wells** (deep
American VOG), ElevenLabs `eleven_v3`. Sources in `assets/`; shipped copies in
`packages/client/public/`. Wired via `packages/client/src/common/receiverAudio.ts`
(`useReceiverAudio`), which fires cues off spectator-projection state changes.

| File | Cue | Trigger |
|---|---|---|
| `cue-round-open.mp3` | "Incoming transmission… pinpoint it." | Phase enters `GUESS_FIRST` / `GUESS_SECOND` |
| `cue-correct.mp3` | "Target acquired. Well done, agent." | A guess step's `spokenResult` becomes `CORRECT` |
| `cue-incorrect.mp3` | "Negative. Intel was compromised. Regroup." | …becomes `INCORRECT` |

Playback is best-effort: on a Cast device it just plays; in a plain browser tab
the first cue may wait for a user interaction. Never surfaced as an error.

## Standing orders

1. **Two inks, one ground** — red + ink-black do the work.
2. **Everything is filed** — hard borders, hard shadow; no web-card softness.
3. **Talk like a handler** — see voice table.
4. **Stamp, don't label** — mono, wide tracking, uppercase, often reversed out of ink.
5. **Keep the margins busy** — registration crosses, case numbers, CLASSIFIED bands; center stays legible.
6. **Motion is mechanical** — hinges and translations, never opacity fade-ins; respect `prefers-reduced-motion`.

## Assets

| File | Use |
|---|---|
| `assets/poster-recruitment.webp` | Hero / marketing / loading screen |
| `assets/texture-topsecret-tile.webp` | Low-contrast background texture |
| `assets/icon-plate.webp` | Icon reference sheet |
| `assets/mockup-clue-submission.webp` | Player-screen visual target |

Generated with Ideogram 4.0 (images) and ElevenLabs v3 (audio).
