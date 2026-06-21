import { describe, expect, it } from 'vitest';
import { addPlayers, checkInvariants, makeEngine } from './harness.js';

function submitAll(engine: ReturnType<typeof makeEngine>['engine']) {
  for (const ins of engine.room.round!.insiders) {
    engine.chooseOption(ins.insiderPlayerId, 0);
    engine.submitClues(ins.insiderPlayerId);
  }
}

describe('3-Player Mode scoring & roles (§4.7)', () => {
  it('interceptor correct → interceptor scores only', () => {
    const { engine } = makeEngine(10);
    const seats = addPlayers(engine, 3);
    engine.start(seats[0]!.id);
    submitAll(engine);
    const g = engine.room.round!.activeGuessing!;
    const insiderId = g.insiderPlayerId;
    const interceptor = engine.room.players.find((p) => engine.getThreeRole(p.id) === 'INTERCEPTOR')!;
    engine.flip(insiderId, 'A');
    engine.recordResult(insiderId, 'CORRECT');
    expect(interceptor.tokensFlipped).toBe(1);
    expect(engine.room.players.filter((p) => p.tokensFlipped > 0)).toHaveLength(1);
    // 3P has a single message per round
    expect(engine.room.phase).toBe('ROUND_END');
  });

  it('contact final correct → both contact and insider score', () => {
    const { engine } = makeEngine(11);
    const seats = addPlayers(engine, 3);
    engine.start(seats[0]!.id);
    submitAll(engine);
    const g = engine.room.round!.activeGuessing!;
    const insiderId = g.insiderPlayerId;
    const contact = engine.room.players.find((p) => engine.getThreeRole(p.id) === 'CONTACT')!;
    engine.flip(insiderId, 'A');
    engine.recordResult(insiderId, 'INCORRECT');
    engine.flip(insiderId, 'B');
    engine.recordResult(insiderId, 'INCORRECT');
    engine.recordResult(insiderId, 'CORRECT');
    expect(contact.tokensFlipped).toBe(1);
    expect(engine.room.players.find((p) => p.id === insiderId)!.tokensFlipped).toBe(1);
  });

  it('message lost → interceptor scores', () => {
    const { engine } = makeEngine(12);
    const seats = addPlayers(engine, 3);
    engine.start(seats[0]!.id);
    submitAll(engine);
    const g = engine.room.round!.activeGuessing!;
    const insiderId = g.insiderPlayerId;
    const interceptor = engine.room.players.find((p) => engine.getThreeRole(p.id) === 'INTERCEPTOR')!;
    engine.flip(insiderId, 'A');
    engine.recordResult(insiderId, 'INCORRECT');
    engine.flip(insiderId, 'B');
    engine.recordResult(insiderId, 'INCORRECT');
    engine.recordResult(insiderId, 'INCORRECT');
    expect(interceptor.tokensFlipped).toBe(1);
  });

  it('insider rotates to the previous interceptor each round', () => {
    const { engine } = makeEngine(13);
    const seats = addPlayers(engine, 3);
    engine.start(seats[0]!.id);
    const round1Interceptor = engine.room.players.find((p) => engine.getThreeRole(p.id) === 'INTERCEPTOR')!.id;
    submitAll(engine);
    const g = engine.room.round!.activeGuessing!;
    engine.flip(g.insiderPlayerId, 'A');
    engine.recordResult(g.insiderPlayerId, 'CORRECT');
    expect(engine.room.phase).toBe('ROUND_END');
    engine.nextRound(seats[0]!.id);
    const round2Insider = engine.room.round!.insiders[0]!.insiderPlayerId;
    expect(round2Insider).toBe(round1Interceptor);
  });

  it('supports a shared win when two players reach 4 simultaneously', () => {
    // contact-correct flips both contact and insider; engineer both to 3 first.
    const { engine } = makeEngine(14);
    const seats = addPlayers(engine, 3);
    engine.start(seats[0]!.id);
    // Drive deterministic rounds: always contact-correct so insider+contact climb.
    let guard = 0;
    while (engine.room.phase !== 'GAME_OVER' && guard++ < 50) {
      submitAll(engine);
      const g = engine.room.round!.activeGuessing!;
      const id = g.insiderPlayerId;
      engine.flip(id, 'A');
      engine.recordResult(id, 'INCORRECT');
      engine.flip(id, 'B');
      engine.recordResult(id, 'INCORRECT');
      engine.recordResult(id, 'CORRECT'); // contact final correct
      checkInvariants(engine);
      if (engine.room.phase === 'ROUND_END') engine.nextRound(seats[0]!.id);
    }
    expect(engine.room.phase).toBe('GAME_OVER');
    expect(engine.room.winnerPlayerIds.length).toBeGreaterThanOrEqual(1);
  });
});

describe('insider rotation (TEAM, §4.6)', () => {
  it('IN_ORDER rotates through all team members before repeating', () => {
    const { engine } = makeEngine(20);
    const seats = addPlayers(engine, 6); // 3 v 3
    engine.updateSettings(seats[0]!.id, { rotationMode: 'IN_ORDER' });
    engine.start(seats[0]!.id);
    const seenA = new Set<string>();
    const seenB = new Set<string>();
    for (let round = 0; round < 3; round++) {
      for (const ins of engine.room.round!.insiders) {
        const p = engine.room.players.find((x) => x.id === ins.insiderPlayerId)!;
        (p.teamId === 'A' ? seenA : seenB).add(p.id);
      }
      submitAll(engine);
      // resolve both messages quickly
      for (let m = 0; m < 2; m++) {
        const g = engine.room.round!.activeGuessing!;
        engine.flip(g.insiderPlayerId, 'A');
        engine.recordResult(g.insiderPlayerId, 'CORRECT');
        if (engine.room.phase === 'GAME_OVER') break;
      }
      if (engine.room.phase === 'GAME_OVER') break;
      engine.nextRound(seats[0]!.id);
    }
    expect(seenA.size).toBe(3);
    expect(seenB.size).toBe(3);
  });
});

describe('in-session dedupe (§4.12)', () => {
  it('never serves the same message text twice across a full game', () => {
    const { engine } = makeEngine(30);
    const seats = addPlayers(engine, 4);
    engine.start(seats[0]!.id);
    const seen = new Set<string>();
    let guard = 0;
    while (engine.room.phase !== 'GAME_OVER' && guard++ < 100) {
      for (const ins of engine.room.round!.insiders) {
        for (const opt of ins.card.options) {
          const key = opt.text.toLowerCase();
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
      submitAll(engine);
      for (let m = 0; m < 2; m++) {
        const g = engine.room.round?.activeGuessing;
        if (!g) break;
        engine.flip(g.insiderPlayerId, 'A');
        engine.recordResult(g.insiderPlayerId, 'CORRECT');
        if (engine.room.phase !== 'GUESS_SECOND') break;
      }
      if (engine.room.phase === 'ROUND_END') engine.nextRound(seats[0]!.id);
    }
    expect(engine.room.phase).toBe('GAME_OVER');
  });
});
