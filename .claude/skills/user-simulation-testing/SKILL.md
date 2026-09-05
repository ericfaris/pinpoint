---
name: user-simulation-testing
description: Play a batch of simulated multi-user game sessions end-to-end (varied party sizes, realistic messy human behavior) to hunt for real bugs, then file/fix/verify them via GitHub issues. Use when the user wants "user testing", "simulate games/sessions", "play through as real users", or asks to find edge-case bugs a normal user would hit.
triggers:
  - "simulate games"
  - "simulate users"
  - "user testing"
  - "play through as a user"
  - "play some games and find bugs"
  - "test with different numbers of players"
  - "edge case testing"
---

This skill drives a batch of full, realistic game sessions against the **real
server/engine** (not just unit-level fuzzing, not a browser UI simulation) to
surface bugs that only show up when actual messy human behavior meets the
full stack — network drops, sloppy input, mid-session joins, settings
changes, rematches — then turns confirmed bugs into filed, fixed, and
verified GitHub issues.

Pinpoint's own suite is the reference example:
`packages/server/src/net/__tests__/user-simulation.test.ts`.

## Parameters

- **Number of games** (`args`, default **6** if the user doesn't say):
  how many full simulated sessions the batch plays. Scale the *shapes*
  in step 2 to fit this count — with more games, add more distinct
  behaviors-on-top rather than repeating the same scenario at a new
  player count; with fewer (e.g. 3), prioritize the highest-yield
  shapes: the minimum player count, the maximum, and a permanent
  mid-game disconnect. If the user names specific player counts or
  scenarios instead of (or in addition to) a plain number, honor those
  directly rather than re-deriving them from the count.
- **Player-count range**, if the app has a configurable min/max: default
  to spanning it (see step 2) unless the user asks for a narrower band.

## When to reach for this vs. other testing

- Already-existing engine/unit simulations (e.g. `simulation.test.ts` here)
  fuzz pure game logic in isolation across many seeds — good for state-machine
  correctness, bad at catching integration bugs (wire protocol, socket
  lifecycle, timers, host-authority edge cases).
- `webapp-testing` (Playwright) drives the actual browser UI — use it when the
  suspected bug is in rendering/interaction, not server logic.
- **This skill** sits in between: real client↔server traffic over the actual
  transport (WebSockets, HTTP, whatever the app uses), asserting on protocol
  responses and server-side state, without a browser. It's the fastest way to
  exercise realistic multi-user scenarios with tight control over timing.

## Workflow

1. **Learn the stack before writing anything.**
   - Find the wire protocol / API surface (client→server intents, server→client
     events) and the authoritative state model.
   - Find any existing integration test harness (a test client wrapper, a
     way to boot the real server in-process) and reuse its patterns instead of
     inventing new ones — consistency makes bugs found here trustworthy.
   - Find any existing invariant-checker used by unit-level simulations and
     reuse it (call it after every mutating step in the new suite too). If
     none exists, write one covering the properties that must never break:
     monotonic counters, exactly-one-of invariants (host, active turn),
     no-leaked-hidden-state, referential integrity (state referencing ids
     that must still exist).

2. **Design the game batch around *shapes*, not just a count.** "N games with
   different numbers of players" is the entry point, but pick player counts
   that hit real boundaries of the app's rules (its min, its max, any mode
   switch threshold, one comfortably in the middle) — don't just pick N
   arbitrary numbers. For each game, layer in one or two realistic
   human/network behaviors on top of the normal play-through:
   - sloppy input: whitespace-padded names, case-only duplicates, empty
     submissions
   - mid-session joins/leaves while play is underway
   - a brief network blip that should be invisible vs. a real drop that
     shouldn't be
   - a participant who disconnects and **never comes back** — this is the
     single highest-yield scenario for finding "the host has no recovery
     path" bugs
   - settings/config changes at the boundary of when they're allowed
   - restart/rematch/replay flows, especially with a stale (disconnected or
     removed) participant still on the roster
   - rapid duplicate/out-of-order actions from the same client
   - the two extremes of whatever randomness drives outcomes (always-succeed,
     always-fail) to make sure both terminate

   **Don't stop at session lifecycle — play the actual game.** It's easy for
   the whole batch to drive gameplay through placeholder content (the same
   fixed clue word every time, always picking option 0, always guessing
   correct) because that's what makes a scripted driver simple. That
   completely misses bugs that only live in the rule-enforcement and
   resource-supply layers underneath the session plumbing:
   - **Content the rules should reject but the server might not**: an
     empty/blank submission where one action, another value where it's
     disallowed, input that's supposed to be constrained (one word, a
     bounded range, a required prior choice) but isn't actually validated
     server-side — client-side hints (a placeholder, a maxlength) are not
     enforcement. Try to submit exactly what the client's own UI copy tells
     the user *not* to.
   - **Resource/supply exhaustion**: anything the game deals out — content
     from a generator or pool, a shuffled deck, an external API call — has a
     "we're out" case. Simulate it running dry *mid-session* (not just at
     start) with a stub/fake supplying the real dependency, and confirm the
     failure is a normal, surfaced, retriable error — not a thrown exception.
     A throw with nothing above it to catch it inside a long-running
     socket/event server doesn't just fail that one action, it can crash the
     process for every concurrent session (grep for `throw new Error` in the
     core state machine and ask, for each one, "what catches this, and does
     that failure stay scoped to the one session that hit it?").
   - **Score/outcome correctness under real content**: drive at least one
     full game through with varied real inputs (not the same fixed value
     every round) and assert the final score/outcome by recomputing it
     independently from the sequence of actions taken, not just "the phase
     reached GAME_OVER."
   - **Feedback-only / fire-and-forget actions**: any action whose whole
     point is to leave a signal for someone else (a report/flag button, a
     "notify the host" action, an analytics ping) is easy to wire server-side
     and then forget to give the *acting user* any visible confirmation.
     Check that every such action produces some observable effect for the
     person who took it, not just a server-side log line.

3. **Audit whether the game's own instructions are clear, not just whether it
   works.** A feature that behaves correctly but gives a real user no way to
   tell it happened is a bug even when every assertion in your test suite
   passes. While you're driving each scenario, read the actual on-screen copy
   the way a first-time player would and check for:
   - an action with **zero visible feedback** (nothing changes on screen,
     no toast/confirmation) — the flag/report pattern above is the classic
     case, but check every fire-and-forget button
   - an error message that's technically correct but not something a
     non-technical player would know what to do with (compare what the
     server returns vs. what's shown — is a raw internal message leaking to
     the UI?)
   - a state a player can get stuck in with no on-screen indication of what
     to do next (this is exactly what the "permanent disconnect" scenario in
     step 2 is designed to surface — check that the *recovery path*, once
     you build/find one, is something a host would actually discover without
     reading the source)
   Findings here are real bugs — file and treat them the same as a logic
   bug — but when the "correct" behavior is a game-rule/design judgment call
   (e.g., should free-text input be more strictly validated, changing what
   a player is and isn't allowed to type) rather than an obvious defect,
   surface it as a finding for the user to decide rather than unilaterally
   changing game rules.

4. **Drive it for real, assert on real state.** Boot the actual server
   in-process (ephemeral port), connect real client sockets/HTTP clients, and
   drive every action through the real API — never call internal engine
   methods directly except to run the invariant checker or inspect state the
   protocol wouldn't otherwise expose. A bug that only reproduces through the
   real transport (timing, serialization, ack flow) is exactly what this
   layer is for.

5. **When a test fails, determine test-bug vs. product-bug before touching
   product code.** Read the failure against the actual source of the feature
   it exercises. Common test-harness mistakes to rule out first: awaiting an
   ack on a fire-and-forget event (hangs to timeout), holding a stale client
   reference after a reconnect gives it a new identity, accidentally routing
   the scenario through the host when the scenario requires the host to stay
   available. Only once you've confirmed the server did something the spec/
   design doesn't intend is it a real bug.

6. **File one issue per confirmed bug** (use the `create-issue` skill or
   `gh issue create` directly) before fixing, with: what happens, the
   scenario that found it (name the test), user impact in concrete terms, and
   root cause once known. This creates a paper trail independent of the fix
   commit and gives you an issue number to close.

7. **Fix minimally and re-verify.**
   - Fix the root cause in the smallest surface area — don't refactor
     adjacent code while you're in there.
   - If the bug has a user-facing surface (a missing recovery action, a
     confusing state with no way out), also add or update the UI so a real
     user can actually reach the fix — a server-only fix for a host-facing
     recovery flow is incomplete. Check for a parallel client/store method
     and screen to wire up, matching existing patterns.
   - Re-run the specific failing scenario, then the **entire** existing test
     suite (unit + integration + this new batch) — a fix for one scenario
     regressing another is exactly what a shared invariant checker is meant
     to catch. Also re-run typecheck/build across every touched package if
     the project is a monorepo with generated build artifacts consumed
     cross-package (a shared protocol package needs rebuilding before a
     server package will typecheck against it).

8. **Land the batch as one changeset**: the new test suite plus every fix it
   motivated, referencing the filed issues (`Fixes #N`) so they auto-close on
   merge. Branch off the default branch first if working directly in it engine
   isn't already routed through a PR-based flow; open a PR with a summary of
   bugs found/fixed and the verification that was run.

9. **Leave the suite behind.** The batch of simulated games is a regression
   suite now, not a one-off script — it belongs in the same test directory
   and `npm test`/CI path as everything else, not in a scratch file that gets
   deleted after this session.
