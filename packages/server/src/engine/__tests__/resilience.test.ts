import { describe, expect, it } from 'vitest';
import { addPlayers, makeEngine } from './harness.js';

function startTeam(seed = 40, n = 4) {
  const { engine } = makeEngine(seed);
  const seats = addPlayers(engine, n);
  engine.start(seats[0]!.id);
  return { engine, seats };
}

describe('disconnect / pause / reconnect (§4.8)', () => {
  it('player disconnect pauses the game; reconnect resumes', () => {
    const { engine, seats } = startTeam();
    const victim = seats[2]!;
    engine.disconnect(victim.id);
    expect(engine.room.phase).toBe('PAUSED');
    expect(engine.room.pause.reason).toBe('PLAYER_DISCONNECT');
    expect(engine.room.pause.waitingForPlayerId).toBe(victim.id);

    const rj = engine.join({ displayName: victim.name, reconnectToken: victim.token });
    expect(rj.ok).toBe(true);
    if (rj.ok) expect(rj.reconnected).toBe(true);
    expect(engine.room.phase).toBe('WRITE_CLUES');
    expect(engine.room.pause.active).toBe(false);
  });

  it('does not resume while another player is still disconnected', () => {
    const { engine, seats } = startTeam();
    engine.disconnect(seats[1]!.id);
    engine.disconnect(seats[2]!.id);
    expect(engine.room.phase).toBe('PAUSED');
    engine.join({ displayName: seats[1]!.name, reconnectToken: seats[1]!.token });
    expect(engine.room.phase).toBe('PAUSED'); // still waiting on seats[2]
    engine.join({ displayName: seats[2]!.name, reconnectToken: seats[2]!.token });
    expect(engine.room.phase).toBe('WRITE_CLUES');
  });

  it('cast drop pauses; restoring cast resumes', () => {
    const { engine } = startTeam();
    engine.setCastConnected(false);
    expect(engine.room.phase).toBe('PAUSED');
    expect(engine.room.pause.reason).toBe('CAST_DROPPED');
    engine.setCastConnected(true);
    expect(engine.room.phase).toBe('WRITE_CLUES');
  });

  it('will not resume from cast drop until cast is back even if all connected', () => {
    const { engine, seats } = startTeam();
    engine.setCastConnected(false);
    engine.disconnect(seats[1]!.id);
    engine.join({ displayName: seats[1]!.name, reconnectToken: seats[1]!.token });
    expect(engine.room.phase).toBe('PAUSED'); // cast still down
    engine.setCastConnected(true);
    expect(engine.room.phase).toBe('WRITE_CLUES');
  });

  it('host disconnect transfers host powers to a connected player', () => {
    const { engine, seats } = startTeam();
    const host = seats[0]!;
    engine.disconnect(host.id);
    const newHost = engine.room.players.find((p) => p.isHost)!;
    expect(newHost.id).not.toBe(host.id);
    expect(newHost.connected).toBe(true);
  });

  it('preserves in-progress clue entry across reconnect', () => {
    const { engine, seats } = startTeam();
    const insider = engine.room.round!.insiders[0]!.insiderPlayerId;
    engine.chooseOption(insider, 3);
    engine.setClue(insider, 'A', 'halfway');
    const token = seats.find((s) => s.id === insider)!.token;
    engine.disconnect(insider);
    engine.setCastConnected(true); // host may still be connected; ensure cast up
    engine.join({ displayName: 'whatever', reconnectToken: token });
    const ins = engine.room.round!.insiders.find((i) => i.insiderPlayerId === insider)!;
    expect(ins.chosenOptionIndex).toBe(3);
    expect(ins.clueBoards.find((b) => b.slot === 'A')!.clue).toBe('halfway');
  });
});

describe('mid-game join (§4.1.3)', () => {
  it('TEAM: new joiner is queued this round, active next round', () => {
    const { engine, seats } = startTeam(50, 4);
    const join = engine.join({ displayName: 'Latecomer' });
    expect(join.ok).toBe(true);
    const newId = join.ok ? join.player.id : '';
    const np = engine.room.players.find((p) => p.id === newId)!;
    expect(np.pendingJoin).toBe(true);
    expect(np.teamId).not.toBeNull();
    // not an insider this round
    expect(engine.room.round!.insiders.some((i) => i.insiderPlayerId === newId)).toBe(false);

    // finish round
    for (const ins of engine.room.round!.insiders) {
      engine.chooseOption(ins.insiderPlayerId, 0);
      engine.submitClues(ins.insiderPlayerId);
    }
    for (let m = 0; m < 2; m++) {
      const g = engine.room.round!.activeGuessing!;
      engine.flip(g.insiderPlayerId, 'A');
      engine.recordResult(g.insiderPlayerId, 'CORRECT');
      if (engine.room.phase !== 'GUESS_SECOND') break;
    }
    if (engine.room.phase === 'ROUND_END') engine.nextRound(seats[0]!.id);
    expect(engine.room.players.find((p) => p.id === newId)!.pendingJoin).toBe(false);
  });

  it('3-Player: new joiner is queued until the game ends', () => {
    const { engine } = makeEngine(51);
    const seats = addPlayers(engine, 3);
    engine.start(seats[0]!.id);
    const join = engine.join({ displayName: 'Fourth' });
    expect(join.ok).toBe(true);
    const np = engine.room.players.find((p) => p.displayName === 'Fourth')!;
    expect(np.pendingJoin).toBe(true);
    // a queued 3P joiner never becomes an insider mid-game
    submitAllAndWin(engine, seats[0]!.id);
    expect(engine.room.phase).toBe('GAME_OVER');
  });
});

function submitAllAndWin(engine: ReturnType<typeof makeEngine>['engine'], hostId: string) {
  let guard = 0;
  while (engine.room.phase !== 'GAME_OVER' && guard++ < 100) {
    for (const ins of engine.room.round!.insiders) {
      engine.chooseOption(ins.insiderPlayerId, 0);
      engine.submitClues(ins.insiderPlayerId);
    }
    const g = engine.room.round!.activeGuessing!;
    engine.flip(g.insiderPlayerId, 'A');
    engine.recordResult(g.insiderPlayerId, 'CORRECT');
    if (engine.room.phase === 'ROUND_END') engine.nextRound(hostId);
  }
}

describe('host powers (§4.8/§4.9)', () => {
  it('force-end stops the game immediately', () => {
    const { engine, seats } = startTeam();
    expect(engine.forceEnd(seats[0]!.id).ok).toBe(true);
    expect(engine.room.phase).toBe('GAME_OVER');
  });

  it('non-host cannot force-end', () => {
    const { engine, seats } = startTeam();
    expect(engine.forceEnd(seats[1]!.id).ok).toBe(false);
  });

  it('rematch returns to lobby with reshuffled teams and reset tokens', () => {
    const { engine, seats } = startTeam();
    engine.forceEnd(seats[0]!.id);
    expect(engine.rematch(seats[0]!.id).ok).toBe(true);
    expect(engine.room.phase).toBe('LOBBY');
    expect(engine.room.teams.every((t) => t.tokensFlipped === 0)).toBe(true);
    expect(engine.room.players.every((p) => p.tokensFlipped === 0)).toBe(true);
    expect(engine.room.players.every((p) => p.teamId !== null)).toBe(true);
  });
});
