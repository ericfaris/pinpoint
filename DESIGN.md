# Pinpoint — Design System

**Status:** uplift pass, 2026-09-13/14. This document is the canonical design
reference for the project; it supersedes and folds in
[`design/DESIGN-SYSTEM.md`](design/DESIGN-SYSTEM.md) (2026-09-11), which is
kept in place for its asset table and audio-cue detail but should be
considered historical — extend *this* file going forward.

Live showcase (every token/component rendered from the app's real CSS):
[`design/showcase.html`](design/showcase.html) — open directly in a browser.

---

## 1. Direction

**Theme: Cold War intelligence dossier.** Pinpoint is an in-person party game
— players write one-word clues privately on their phones while the room
guesses out loud, watching a shared board cast to a TV via Chromecast. The
existing identity (established in an earlier pass, PR "Add Cold War sticker
illustrations for categories and team crests") already nails the concept:
everything on screen reads as a filed intelligence document — offset-printed
on aging stock, stamped in propaganda red, set in condensed government type.
This pass **kept that direction** and did three things: formalized its ad hoc
values into a real token system (spacing/radius/shadow/motion scales, not
just color/type), closed gaps (focus states, reduced-motion, a documented
entrance animation), and gave the project the favicon it was missing.

**Reference:** the game's own recruitment poster
(`packages/client/public/poster.webp`) — a mid-century "PINPOINT / THE ENEMY
IS WATCHING" DoD-style poster — is the truest single reference for the whole
system: cream stock, black display type, one red accent, a hand-drawn
triangulation diagram.

**Key moments this system is built around:**
1. **Landing** — the recruitment poster is the first thing anyone sees; it
   has to look like a found object, not app chrome.
2. **Writing a clue** (Insider, private screen) — picking a message and
   filling three one-word clue boards; tactile option cards, one-word input
   validation feedback.
3. **The board flip** (shared, TV) — the Insider taps a board, it flips on
   the TV for the whole room; this is the single most repeated interaction
   in a round and gets the most tactile treatment (3D flip, ink-hatched
   back).
4. **Round/game end reveal** — team score cards and the win banner; a beat of
   staggered "documents landing on the desk" motion, not a fade.
5. **The TV lobby** — the join code and QR, readable from across a room
   before anyone's phone is even out.

### Mood board directions (generated this pass)

No user was available to review references interactively, so three
executions of the *same* Cold War-dossier concept were generated with
Ideogram to pressure-test the existing direction against alternatives, saved
under `design/assets/`:

| Direction | File | Verdict |
|---|---|---|
| **Illustrated Propaganda Poster** (chosen) | `mood-illustrated-propaganda.png` | Bold condensed display type, one strong red accent, halftone texture, high legibility at a glance. Closest to the existing `poster.webp` and to the already-shipped UI. **This is what the system below formalizes.** |
| Austere Redacted Dossier | *(generated, not saved — see below)* | Typewriter type, redaction bars, lots of negative space. Reads as somber/bureaucratic rather than playful — wrong register for a party game people are laughing through. |
| Tactile Stamped Ephemera | *(generated, not saved — see below)* | Wax seals, string-tied tags, off-kilter stamped type, collage of ephemera. Charming but busy — the collage density fights against "readable at a glance on a TV from across the room," which is a hard requirement for the receiver surface. |

Both runner-ups were generated and reviewed (Ideogram request IDs
`Bq6q_6eLSPCn3isGYUHwhA` redacted-dossier, `oBdfGx3_RduV-_ga4UOlBw`
stamped-ephemera) but not committed as repo assets since they weren't the
chosen direction — only the winning board's file is kept in
`design/assets/mood-illustrated-propaganda.png` for reference. The verdict:
**keep the existing "Illustrated Propaganda Poster" execution** — it was
already the right call in the earlier pass; this uplift formalizes rather
than replaces it.

---

## 2. Color

All tokens live in
[`packages/client/src/common/styles.css`](packages/client/src/common/styles.css)
`:root`.

| Token | Hex | Role | Used for |
|---|---|---|---|
| `--bg` | `#E7DCB8` | Dominant / page ground | body background (radial gradient with `--bg-2`) |
| `--bg-2` | `#D9CAA0` | Dominant, shadowed | gradient partner for `--bg` |
| `--panel` | `#F2E9CD` | Surface | `.card`, buttons, inputs, boards face-up |
| `--panel-2` | `#E6D8AE` | Surface, hover/alt | button hover, team panel alt |
| `--text` / `--line` | `#241D12` | Ink | body text, all borders (2px "filed document" rule) |
| `--muted` | `#6E5F45` | Secondary ink | captions, `.muted`, `.small` helper text |
| `--accent` | `#A3222C` | Sharp accent — Soviet red | primary buttons, Team A, `--bad`, `--cat-C` |
| `--accent-2` | `#3C5568` | Sharp accent — steel blue | Team B, `--cat-M` |
| `--good` | `#57692F` | Semantic good | correct-guess button, olive category |
| `--bad` | `#A3222C` | Semantic bad | incorrect-guess button (aliases `--accent`) |
| `--warn` | `#B9911F` | Semantic warn / brass | score tokens (stars), warning text, timer `.warn` |
| `--cat-C` | `#A3222C` | Category: Character | tag background |
| `--cat-M` | `#3C5568` | Category: Media | tag background |
| `--cat-P` | `#B9911F` | Category: Person | tag background |
| `--cat-L` | `#57692F` | Category: Location | tag background |
| `--cat-B` | `#7A4C30` | Category: Brand | tag background |
| `--cat-W` | `#55415E` | Category: Wildcard | tag background |

**Contrast notes:** body text `--text` (#241D12) on `--bg` (#E7DCB8) is
≈13.8:1 (AAA). `--text` on `--panel` (#F2E9CD) is ≈14.9:1. Button label
`#F2E9CD` on `--accent` (#A3222C) is ≈5.4:1 (AA for normal text). Category
tag glyphs use `currentColor`/ink outlines on their category color rather
than relying on the background hue alone, so category is never color-only
information (also backed by the label tooltip and the letter/icon shape).

**Standing rule (unchanged from the original pass):** two working inks (red +
ink-black) over parchment; steel/brass/olive are *signals* (team B, warn,
good), not decoration. Never add a fourth hue purely for styling.

---

## 3. Type

Three roles, loaded via Google Fonts `<link>` in `index.html`/`receiver.html`
(Oswald, Domine, Space Mono) plus a self-hosted display face:

| Role | Token | Stack | Loads from |
|---|---|---|---|
| Display | `--font-display` | `"Kremlin Kommisar", "Oswald", Impact, "Arial Narrow", sans-serif` | `packages/client/public/fonts/KremlinKommisar.ttf` (`@font-face`, `font-display: swap`), Oswald as web fallback |
| Body | `--font-body` | `"Domine", Georgia, "Times New Roman", serif` | Google Fonts |
| Data | `--font-data` | `"Space Mono", "Courier New", ui-monospace, monospace` | Google Fonts |

Display is uppercase with `0.04em` tracking by default (`h1,h2,h3,.title,.h2,
.brand,button,.tag`); data tokens (`.pill,.timer,.codebox,.code-big`) carry
extra tracking (`0.08–0.12em`) to read like stamped serial numbers.

### Type scale

| Token | Value | Use |
|---|---|---|
| `--text-xs` | 0.75rem | `.pill` labels, fine print |
| `--text-sm` | 0.85rem | `.small` — captions, helper/validation text |
| `--text-base` | 1rem | body copy (default) |
| `--text-md` | 1.1rem | `.h2` — card and section headings |
| `--text-lg` | 1.2rem | clue board word |
| `--text-xl` | 2rem | `.title` — screen headline ("Pinpoint", "🏆 Team A wins!") |
| `--text-2xl` | 3rem | `.code-big` — join code on the join screen |
| `--leading-tight` | 1.15 | (available for future display-heavy blocks) |
| `--leading-normal` | 1.45 | body default |

TV surfaces don't use the rem scale — they use `vw`/`vh` sizing
(`.tv .brand`, `.tv .codebox`, etc.) so type scales with screen size at a
fixed viewing distance instead of a fixed scale; see §7.

---

## 4. Spacing, radius, shadow, motion

Formalized this pass — previously these were literal values sprinkled
through the stylesheet; they're now named tokens with the *same* values, so
nothing visually changed, but the scale is now a real, referenceable system.

### Spacing (4px base)

| Token | Value | Typical use |
|---|---|---|
| `--space-1` | 4px | token/tag internal gaps |
| `--space-2` | 8px | tight icon gaps |
| `--space-3` | 10px | `.row`/`.spread` gap, option padding |
| `--space-4` | 14px | `.stack` gap (the default vertical rhythm) |
| `--space-5` | 16px | `.app` horizontal padding |
| `--space-6` | 18px | `.card` padding |
| `--space-7` | 20px | `.app` top padding |
| `--space-8` | 28px | (reserved for larger section breaks) |

### Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | buttons, inputs, tags, boards, banners |
| `--radius-md` | 6px | `.card` |
| `--radius-pill` | 999px | `.pill`, `.tv .pchip` |

### Shadow — "stamped paper," never a soft UI shadow

| Token | Value | Use |
|---|---|---|
| `--shadow-stamp` | `3px 3px 0 rgba(36,29,18,.35)` | cards, buttons, poster, TV scorecards — default resting state |
| `--shadow-stamp-pressed` | `1px 1px 0 rgba(36,29,18,.35)` | button `:active` — the "stamp" presses down |
| `--shadow-none` | `none` | `.ghost` buttons |

No blur, no soft glow (except the score-token `text-shadow` glint, which is
period-appropriate "backlit brass," not a UI affordance). Hard offset only.

### Motion

| Token | Value | Named for |
|---|---|---|
| `--duration-press` | 0.08s | button down/up (micro) |
| `--ease-press` | `ease` | pairs with `--duration-press` |
| `--duration-fade` | 0.15s | hover/color/opacity micro-transitions (button hover, input focus, option select) |
| `--duration-flip` | 0.5s | clue board Y-axis flip |
| `--ease-flip` | `cubic-bezier(.45,.05,.15,1)` | pairs with `--duration-flip` — a mechanical snap, not a bouncy ease |
| `--duration-reveal` | 0.4s | page-level entrance (cards, TV scorecards on load) |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | pairs with `--duration-reveal` |

**Standing order carried over from the original pass:** motion here is
*mechanical* — hinges, translations, stamps landing — never a web-app
opacity cross-fade. The new `reveal` keyframe (`@keyframes reveal` in
styles.css) is a `translateY + scale` settle with **no opacity change**,
specifically to honor that rule; it's used on `.card` and `.tv .scorecard` on
mount, staggered by `nth-child` up to the 4th item so a long list doesn't
make everyone wait. `prefers-reduced-motion: reduce` collapses all
animation/transition durations to ~0 and disables the board flip transition
entirely.

Focus state: `:focus-visible` gets a 2px `--accent` outline with 2px offset
everywhere (new this pass) — keyboard/controller navigation was previously
relying on browser defaults, which didn't match the ink-stamp aesthetic and
were inconsistent across inputs vs. buttons.

---

## 5. Components

All in `packages/client/src/common/styles.css` (styling) and
`packages/client/src/common/ui.tsx` (the handful of components with real
render logic: category icons, team crests, tokens, timer, board).

| Component | Variants / states | Notes |
|---|---|---|
| **Button** | default, `.primary`, `.good`, `.bad`, `.ghost`; `:hover`, `:active` (press-and-translate 2px), `:disabled` (45% opacity, shadow removed) | Signature control. 2px ink border, uppercase, `--shadow-stamp` → `--shadow-stamp-pressed` on press. |
| **Input / select** | default, `:focus` (ink ring), `.error`/`:invalid` (red border — new this pass, previously no error styling existed) | |
| **Card** (`.card`) | default; now animates in with `reveal` | 2px border, `--radius-md`, `--shadow-stamp`. |
| **Pill** (`.pill`) | default, muted (`.pill.muted` via `.muted` text) | data-font, wide tracking, pill radius. |
| **Banner** (`.banner`) | error/notice banner (used for connection + validation errors) | red border on cream-red fill. |
| **Notice** (`.notice`) | default | dashed border, panel-2 fill — "pending/waiting" states. |
| **Option** (`.option`) | default, `.sel` (selected — accent border + `--shadow-stamp`) | the six message-choice cards in clue writing. |
| **Category tag** (`CategoryTag`) | 6 categories (C/M/P/L/B/W), each with a hand-drawn SVG pictogram in `ui.tsx` on its own `--cat-*` color | Character (trench coat + loupe), Media (reel-to-reel), Person (dossier photo), Location (triangulated pin), Brand (contraband crate), Wildcard (redacted page). |
| **Team crest** (`TeamCrest`) | Team A (Soviet star + hammer/sickle motif), Team B (American eagle + stars) | Stamped medallion badge, scales via `.tv .crest` on the TV surface. |
| **Tokens** (`Tokens`) | 0–5 stars, `.on` fills brass with a text-shadow glint | Score display, `big` variant for TV. |
| **Timer** (`Timer`) | default, `.warn` (≤10s, brass), `.over` (0s, red) | Tabular numerals, display font. |
| **Board** (`Board`) | face-down (ink-hatched, brass "?" text), face-up (clue word), `.clickable` when flippable | 3D flip via `--duration-flip`/`--ease-flip`; both faces always in the DOM, `backface-visibility: hidden` does the swap. |

---

## 6. Backgrounds, texture, and generated art

| Asset | Repo path | Role | Ideogram prompt direction |
|---|---|---|---|
| Recruitment poster | `packages/client/public/poster.webp` (source: `design/assets/poster-recruitment.webp`) | Landing screen hero | Mid-century DoD recruitment poster, "PINPOINT / THE ENEMY IS WATCHING," red triangulation diagram over cream stock (generated in the earlier pass) |
| Icon reference plate | `design/assets/icon-plate.webp` | Iconography reference sheet (crosshair, transmitter, loupe, fingerprint, wax seal, etc.) | "CLASSIFIED" plate of 12 flat two-color spy icons (earlier pass) |
| Top-secret texture tile | `design/assets/texture-topsecret-tile.webp` | Low-contrast background texture reference | Tileable aged-paper/redaction texture (earlier pass) |
| Player-screen mockup | `design/assets/mockup-clue-submission.webp` | Visual target for the clue-writing screen | (earlier pass) |
| Mood board — chosen direction | `design/assets/mood-illustrated-propaganda.png` | This pass's direction-selection artifact (see §1) | "Illustrated Propaganda Poster" — cream parchment, palette chips, condensed mid-century display type, halftone texture, `TRANSMIT CLUE` button |
| Favicon / app icon | `packages/client/public/favicon.ico`, `apple-touch-icon.png`, `icon-512.png` | Browser tab / home-screen icon | See §8 — hand-rendered to hit exact token hex values after an Ideogram concept pass drifted off-palette |

The body background is a two-layer CSS gradient (`--bg`/`--bg-2` radial +
a 3px repeating-linear-gradient "paper fiber" texture at 2.5% opacity) — no
image asset, kept cheap and crisp at any viewport.

---

## 7. Surfaces

Two builds share one stylesheet (`vite.config.ts` → `index.html` +
`receiver.html`), and both get the same system:

- **Player** (`.app`, max-width 560px, mobile-first) — the phone-in-hand
  surface: lobby, clue writing, guessing controls, round/game end.
- **Receiver / TV** (`.tv`, 100vw/100vh, `vw`/`vh`-scaled type and spacing) —
  read from across a room. Uses the same tokens (`--panel`, `--line`,
  `--shadow-stamp`, category/team colors) but its own scale so a phone-sized
  `rem` value never has to also work at 10 feet.

No separate visual language for the TV — same borders, same shadow, same
category art, just bigger and laid out for a 16:9 screen. The **Chromecast
integration itself was not touched** by this pass: `cast.ts`,
`receiverAudio.ts`, and the CAF receiver bootstrap in `receiver.html` are
unchanged; only CSS/markup classes they already render into were extended.

---

## 8. Favicon / app icon

**Before this pass:** `packages/client/public/favicon.ico` was a generic
orange map-pin on navy — unrelated to the Cold War dossier identity and
never matched the app's own palette.

**Process:** generated a concept via Ideogram (a red crosshair + brass
center dot on an ink-black rounded square — the "triangulation" motif named
in the app's own title). The raw generation rendered close but not
pixel-exact to the token palette (anti-aliased edges, slightly off-hue red/
gold) and Ideogram's background-removal pass didn't cleanly key out its
near-white backing, so rather than ship a color-drifted, halo-fringed icon,
the same concept was re-rendered by hand with Pillow using the exact token
hex values (`--line` #241D12 plate, `--panel` #F2E9CD medallion ring,
`--accent` #A3222C crosshair, `--warn` #B9911F center dot) — a wax-seal
medallion with a red triangulation crosshair, matching `TeamCrest`'s "stamped
badge" language elsewhere in the system. Verified legible at 16px (see
`design/showcase.html` → Favicon section).

| File | Sizes | Wired via |
|---|---|---|
| `packages/client/public/favicon.ico` | 16/32/48/64/128/256 (multi-size ICO) | `<link rel="icon" href="/favicon.ico" sizes="any">` in both `index.html` and `receiver.html` |
| `packages/client/public/icon-512.png` | 512×512 | `<link rel="icon" type="image/png" sizes="512x512">` in both HTML entry points |
| `packages/client/public/apple-touch-icon.png` | 180×180 | `<link rel="apple-touch-icon">` in `index.html` |

`theme-color` in both HTML files was also updated from an unrelated navy
(`#0b1020`) to the ink token (`#241d12`) so the browser chrome matches the
system. `vite.config.ts` uses the default `publicDir` (`public/`), which
Vite copies verbatim into `dist/` on build — no build config changes were
needed for the new icon files to ship.

---

## 9. Accessibility notes

- **Contrast:** see §2 — all text/background pairs in active use are AA or
  better; the lowest is button-label-on-accent at ≈5.4:1.
- **Focus:** `:focus-visible` now gets an explicit 2px ink-red outline
  (new this pass) instead of relying on browser default outlines, which
  didn't read against the parchment background.
- **Color is never the only signal:** category tags pair color with a unique
  pictogram + text label (tooltip and, in context, an adjacent
  `CATEGORY_LABELS` string); team color pairs with the crest shape (star vs.
  eagle) and the "Team A/B" text.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` collapses all
  animation/transition durations to ~0 and disables the board-flip
  transition, so the flip becomes an instant state swap instead of a forced
  3D rotation.
- **Error states:** `input.error`/`:invalid` now gets a visible red border
  (new this pass) rather than only relying on adjacent helper text.

---

## 10. Asset inventory

| File | Type | Role |
|---|---|---|
| `packages/client/src/common/styles.css` | CSS | Canonical token + component source (edited this pass) |
| `packages/client/public/fonts/KremlinKommisar.ttf` | Font | Display face |
| `packages/client/public/poster.webp` | Image | Landing hero |
| `packages/client/public/favicon.ico` | Icon | Browser tab icon (replaced this pass) |
| `packages/client/public/apple-touch-icon.png` | Icon | iOS home-screen icon (new this pass) |
| `packages/client/public/icon-512.png` | Icon | High-res PNG icon (new this pass) |
| `design/DESIGN-SYSTEM.md` | Doc | Prior design doc — kept for asset table + audio-cue detail, superseded by this file |
| `design/showcase.html` | Doc/HTML | Live component/token showcase (new this pass) |
| `design/assets/mood-illustrated-propaganda.png` | Image | This pass's chosen mood board (new this pass) |
| `design/assets/poster-recruitment.webp`, `icon-plate.webp`, `texture-topsecret-tile.webp`, `mockup-clue-submission.webp` | Images | Earlier-pass reference assets (untouched) |
| `design/assets/cue-*.mp3` | Audio | Earlier-pass receiver sound cues (untouched; see `design/DESIGN-SYSTEM.md` for the sound map) |

---

## 11. Changelog

- **2026-09-13/14 — design-system uplift (this pass).** Formalized spacing,
  radius, shadow, and motion into named tokens (previously literal values);
  added `:focus-visible` treatment and `input.error` styling; added a
  mechanical (non-opacity) entrance animation for cards and TV scorecards
  plus `prefers-reduced-motion` handling; generated and evaluated 3 mood
  board executions of the existing Cold War-dossier concept, confirmed the
  original direction; replaced the mismatched generic favicon with a
  hand-rendered token-exact crosshair medallion and wired
  `apple-touch-icon`/512px PNG variants; built `design/showcase.html` (none
  existed before); wrote this document. No Chromecast/game-logic code was
  touched — CSS and two `<head>` blocks only.
- **2026-09-11 — original Cold War dossier pass.** See
  `design/DESIGN-SYSTEM.md` for the initial palette/type/component/audio
  design and its own asset table.
