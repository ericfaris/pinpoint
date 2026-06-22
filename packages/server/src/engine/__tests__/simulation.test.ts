import { describe, expect, it } from 'vitest';
import { TOKENS_TO_WIN } from '@pinpoint/shared';
import { addPlayers, checkInvariants, makeEngine, playFullGame } from './harness.js';
import { makeRng } from '../rng.js';

describe('full-game simulations across many instances', () => {
  // Run many seeded games at every legal player count and varied luck.
  for (const playerCount of [3, 4, 5, 6, 7, 8]) {
    it(`plays full games to a valid winner with ${playerCount} players`, () => {
      for (let seed = 0; seed < 25; seed++) {
        const { engine } = makeEngine(seed * 100 + playerCount);
        const seats = addPlayers(engine, playerCount);
        const host = seats[0]!;
        const r = engine.start(host.id);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(engine.room.mode).toBe(playerCount === 3 ? 'THREE_PLAYER' : 'TEAM');
        checkInvariants(engine);

        const rand = (() => {
          const g = makeRng(seed * 7 + 1);
          return () => g.next();
        })();
        playFullGame(engine, host.id, { rng: rand, correctProb: 0.45 });

        // a valid terminal state
        expect(engine.room.phase).toBe('GAME_OVER');
        if (engine.room.mode === 'TEAM') {
          expect(engine.room.winnerTeamId).not.toBeNull();
          const wt = engine.room.teams.find((t) => t.id === engine.room.winnerTeamId)!;
          expect(wt.tokensFlipped).toBe(TOKENS_TO_WIN);
          expect(engine.room.winnerPlayerIds).toHaveLength(0);
        } else {
          expect(engine.room.winnerPlayerIds.length).toBeGreaterThanOrEqual(1);
          for (const id of engine.room.winnerPlayerIds) {
            expect(engine.room.players.find((p) => p.id === id)!.tokensFlipped).toBe(TOKENS_TO_WIN);
          }
        }
        checkInvariants(engine);
      }
    });
  }

  it('always-correct and always-wrong extremes still terminate', () => {
    for (const correctProb of [0, 1]) {
      for (const playerCount of [3, 4, 6]) {
        const { engine } = makeEngine(correctProb * 1000 + playerCount);
        const seats = addPlayers(engine, playerCount);
        expect(engine.start(seats[0]!.id).ok).toBe(true);
        const g = makeRng(99);
        const rounds = playFullGame(engine, seats[0]!.id, { rng: () => g.next(), correctProb });
        expect(engine.room.phase).toBe('GAME_OVER');
        expect(rounds).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
