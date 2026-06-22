import { describe, expect, it } from 'vitest';
import {
  CLUE_WRITE_SECONDS,
  GUESS_SECONDS,
} from '@pinpoint/shared';
import { addPlayers, checkInvariants, makeEngine } from './harness.js';
import { toPrivateState, toPublicRoom } from '../project.js';

describe('lobby & team assignment (§4.1, §4.2)', () => {
  it('auto-balances players across two teams as they join', () => {
    const { engine } = makeEngine(1);
    addPlayers(engine, 4);
    const a = engine.room.players.filter((p) => p.teamId === 'A').length;
    const b = engine.room.players.filter((p) => p.teamId === 'B').length;
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it('first joiner is host; exactly one host', () => {
    const { engine } = makeEngine(1);
    const seats = addPlayers(engine, 5);
    expect(engine.room.players.find((p) => p.isHost)!.id).toBe(seats[0]!.id);
    expect(engine.room.players.filter((p) => p.isHost)).toHaveLength(1);
  });

  it('blocks duplicate display names case-insensitively', () => {
    const { engine } = makeEngine(1);
    engine.join({ displayName: 'Alice' });
    const dup = engine.join({ displayName: 'alice' });
    expect(dup.ok).toBe(false);
  });

  it('rejects a 9th player', () => {
    const { engine } = makeEngine(1);
    addPlayers(engine, 8);
    const ninth = engine.join({ displayName: 'P8' });
    expect(ninth.ok).toBe(false);
  });

  it('requires cast connection to start', () => {
    const { engine } = makeEngine(1);
    const seats = addPlayers(engine, 4);
    engine.setCastConnected(false);
    expect(engine.start(seats[0]!.id).ok).toBe(false);
    engine.setCastConnected(true);
    expect(engine.start(seats[0]!.id).ok).toBe(true);
  });

  it('needs >= 3 players to start', () => {
    const { engine } = makeEngine(1);
    const seats = addPlayers(engine, 2);
    expect(engine.start(seats[0]!.id).ok).toBe(false);
  });

  it('blocks start when a team has < 2 players (host imbalance)', () => {
    const { engine } = makeEngine(1);
    const seats = addPlayers(engine, 4);
    // shove everyone onto A
    for (const s of seats) engine.assignTeam(seats[0]!.id, s.id, 'A');
    expect(engine.start(seats[0]!.id).ok).toBe(false);
  });

  it('allows uneven teams (5 players => 3 v 2)', () => {
    const { engine } = makeEngine(1);
    const seats = addPlayers(engine, 5);
    expect(engine.start(seats[0]!.id).ok).toBe(true);
    expect(engine.room.mode).toBe('TEAM');
  });

  it('exactly 3 players triggers THREE_PLAYER mode', () => {
    const { engine } = makeEngine(1);
    const seats = addPlayers(engine, 3);
    expect(engine.start(seats[0]!.id).ok).toBe(true);
    expect(engine.room.mode).toBe('THREE_PLAYER');
    expect(engine.room.players.every((p) => p.teamId === null)).toBe(true);
  });
});

describe('clue phase & first insider (§4.3)', () => {
  it('first insider = earliest submitter; their message guessed first', () => {
    const { engine, clock } = makeEngine(2);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    const [i1, i2] = engine.room.round!.insiders.map((i) => i.insiderPlayerId);
    engine.chooseOption(i2!, 0);
    engine.setClue(i2!, 'A', 'x');
    clock.advance(10);
    expect(engine.submitClues(i2!).ok).toBe(true);
    clock.advance(10);
    engine.chooseOption(i1!, 0);
    engine.submitClues(i1!);
    expect(engine.room.phase).toBe('GUESS_FIRST');
    expect(engine.room.round!.firstInsiderPlayerId).toBe(i2);
    expect(engine.room.round!.activeGuessing!.insiderPlayerId).toBe(i2);
  });

  it('cannot submit without choosing a message', () => {
    const { engine } = makeEngine(2);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    const i1 = engine.room.round!.insiders[0]!.insiderPlayerId;
    expect(engine.submitClues(i1).ok).toBe(false);
  });

  it('non-insiders cannot write clues', () => {
    const { engine } = makeEngine(2);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    const insiders = new Set(engine.room.round!.insiders.map((i) => i.insiderPlayerId));
    const outsider = seats.find((s) => !insiders.has(s.id))!;
    expect(engine.chooseOption(outsider.id, 0).ok).toBe(false);
  });
});

describe('guessing sequence & clue reveals (§4.3 Phase 2)', () => {
  function setupGuessing(seed = 3) {
    const { engine } = makeEngine(seed);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    for (const ins of engine.room.round!.insiders) {
      engine.chooseOption(ins.insiderPlayerId, 0);
      engine.submitClues(ins.insiderPlayerId);
    }
    return { engine, seats };
  }

  it('intercept guesses first, in order, one board per step, reveals accumulate', () => {
    const { engine } = setupGuessing();
    const g = engine.room.round!.activeGuessing!;
    const insider = g.insiderPlayerId;
    expect(engine.room.phase).toBe('GUESS_FIRST');
    expect(g.steps[0]!.guessingTeam).toBe(g.interceptTeam);

    engine.flip(insider, 'A');
    let ins = engine.room.round!.insiders.find((i) => i.insiderPlayerId === insider)!;
    expect(ins.clueBoards.filter((b) => b.faceUp)).toHaveLength(1);
    engine.recordResult(insider, 'INCORRECT');

    expect(engine.room.round!.activeGuessing!.currentStepIndex).toBe(1);
    engine.flip(insider, 'B');
    ins = engine.room.round!.insiders.find((i) => i.insiderPlayerId === insider)!;
    expect(ins.clueBoards.filter((b) => b.faceUp)).toHaveLength(2); // previous stays visible
    engine.recordResult(insider, 'INCORRECT');

    // step 2 auto-reveals the last board for the contact final guess
    expect(engine.room.round!.activeGuessing!.currentStepIndex).toBe(2);
    ins = engine.room.round!.insiders.find((i) => i.insiderPlayerId === insider)!;
    expect(ins.clueBoards.filter((b) => b.faceUp)).toHaveLength(3);
    expect(engine.room.round!.activeGuessing!.steps[2]!.flippedSlot).not.toBeNull();
  });

  it('intercept correct on guess 1 → intercept team scores, message resolved', () => {
    const { engine } = setupGuessing();
    const g = engine.room.round!.activeGuessing!;
    const intercept = g.interceptTeam!;
    engine.flip(g.insiderPlayerId, 'A');
    engine.recordResult(g.insiderPlayerId, 'CORRECT');
    expect(engine.room.teams.find((t) => t.id === intercept)!.tokensFlipped).toBe(1);
    // proceed to second message
    expect(engine.room.phase).toBe('GUESS_SECOND');
  });

  it('all three wrong → message lost, intercept team scores', () => {
    const { engine } = setupGuessing();
    const g = engine.room.round!.activeGuessing!;
    const intercept = g.interceptTeam!;
    engine.flip(g.insiderPlayerId, 'A');
    engine.recordResult(g.insiderPlayerId, 'INCORRECT');
    engine.flip(g.insiderPlayerId, 'B');
    engine.recordResult(g.insiderPlayerId, 'INCORRECT');
    engine.recordResult(g.insiderPlayerId, 'INCORRECT'); // step2 auto-flipped
    expect(engine.room.teams.find((t) => t.id === intercept)!.tokensFlipped).toBe(1);
  });

  it('contact final correct → contact team scores', () => {
    const { engine } = setupGuessing();
    const g = engine.room.round!.activeGuessing!;
    const contact = g.contactTeam!;
    engine.flip(g.insiderPlayerId, 'A');
    engine.recordResult(g.insiderPlayerId, 'INCORRECT');
    engine.flip(g.insiderPlayerId, 'B');
    engine.recordResult(g.insiderPlayerId, 'INCORRECT');
    engine.recordResult(g.insiderPlayerId, 'CORRECT');
    expect(engine.room.teams.find((t) => t.id === contact)!.tokensFlipped).toBe(1);
  });

  it('only the active insider may flip and record', () => {
    const { engine, seats } = setupGuessing();
    const g = engine.room.round!.activeGuessing!;
    const other = seats.find((s) => s.id !== g.insiderPlayerId)!;
    expect(engine.flip(other.id, 'A').ok).toBe(false);
    expect(engine.recordResult(other.id, 'CORRECT').ok).toBe(false);
  });

  it('cannot record a result before flipping', () => {
    const { engine } = setupGuessing();
    const g = engine.room.round!.activeGuessing!;
    expect(engine.recordResult(g.insiderPlayerId, 'CORRECT').ok).toBe(false);
  });
});

describe('casual mode (§4.4)', () => {
  it('reveals the chosen option category when enabled', () => {
    const { engine } = makeEngine(4);
    const seats = addPlayers(engine, 4);
    engine.updateSettings(seats[0]!.id, { casualMode: true });
    engine.start(seats[0]!.id);
    for (const ins of engine.room.round!.insiders) {
      engine.chooseOption(ins.insiderPlayerId, 2);
      engine.submitClues(ins.insiderPlayerId);
    }
    const g = engine.room.round!.activeGuessing!;
    const ins = engine.room.round!.insiders.find((i) => i.insiderPlayerId === g.insiderPlayerId)!;
    expect(g.revealedCategory).toBe(ins.card.options[2]!.category);
  });

  it('hides category when disabled', () => {
    const { engine } = makeEngine(4);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    for (const ins of engine.room.round!.insiders) {
      engine.chooseOption(ins.insiderPlayerId, 2);
      engine.submitClues(ins.insiderPlayerId);
    }
    expect(engine.room.round!.activeGuessing!.revealedCategory).toBeNull();
  });
});

describe('timers (§4.10)', () => {
  it('clue timer expiry auto-submits with blank boards', () => {
    const { engine, clock } = makeEngine(5);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    expect(engine.room.timer.phaseDeadline).toBe(clock.now() + CLUE_WRITE_SECONDS * 1000);
    // nobody chose/wrote anything
    clock.advance(CLUE_WRITE_SECONDS * 1000 + 1);
    engine.clueTimerExpired();
    expect(engine.room.phase).toBe('GUESS_FIRST');
    for (const ins of engine.room.round!.insiders) {
      expect(ins.submitted).toBe(true);
      expect(ins.chosenOptionIndex).toBe(0);
      expect(ins.clueBoards.every((b) => b.clue === '')).toBe(true);
    }
  });

  it('guess timer is a visual cue — expiry has no automatic effect', () => {
    const { engine, clock } = makeEngine(5);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    for (const ins of engine.room.round!.insiders) {
      engine.chooseOption(ins.insiderPlayerId, 0);
      engine.submitClues(ins.insiderPlayerId);
    }
    const before = JSON.stringify(toPublicRoom(engine.room, 0).round!.activeGuessing);
    clock.advance(GUESS_SECONDS * 1000 + 5000);
    // no engine hook fires for guess expiry; state unchanged until insider acts
    const after = JSON.stringify(toPublicRoom(engine.room, 0).round!.activeGuessing);
    expect(after).toBe(before);
  });

  it('timers can be disabled', () => {
    const { engine } = makeEngine(5);
    const seats = addPlayers(engine, 4);
    engine.updateSettings(seats[0]!.id, { timersEnabled: false });
    engine.start(seats[0]!.id);
    expect(engine.room.timer.phaseDeadline).toBeNull();
  });
});

describe('spectator-safe projection (§5)', () => {
  it('non-insider never receives card options or facedown clue words', () => {
    const { engine } = makeEngine(6);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    for (const ins of engine.room.round!.insiders) {
      engine.chooseOption(ins.insiderPlayerId, 1);
      engine.setClue(ins.insiderPlayerId, 'A', 'secretword');
      engine.submitClues(ins.insiderPlayerId);
    }
    const pub = toPublicRoom(engine.room, 0);
    const insiderIds = new Set(engine.room.round!.insiders.map((i) => i.insiderPlayerId));
    // facedown clues are null in public
    for (const insPub of pub.round!.insiders) {
      for (const b of insPub.clueBoards) {
        if (!b.faceUp) expect(b.clue).toBeNull();
      }
    }
    // outsider private state carries no card
    const outsider = seats.find((s) => !insiderIds.has(s.id))!;
    const priv = toPrivateState(engine, outsider.id);
    expect(priv.card).toBeNull();
    // insider private state DOES carry their own card
    const someInsider = [...insiderIds][0]!;
    expect(toPrivateState(engine, someInsider).card).not.toBeNull();
  });
});
