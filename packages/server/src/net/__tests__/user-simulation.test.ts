// User-simulation suite: plays 6 full games end-to-end over real WebSockets,
// each with a different number of players, driving the kind of things real
// players actually do to a party game — join with sloppy names, wander off
// mid-round and never come back, background a tab and come right back,
// change settings before starting, join late while a round is underway, ask
// for a rematch — rather than only the single happy path already covered by
// integration.test.ts. Each scenario also runs the engine's own invariant
// checker (harness.ts) after every mutating step, so a broken invariant
// surfaces as a failure here even if nothing throws.
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { SOCKET_PATH, type Ack, type PrivateState, type PublicRoom, type TeamId } from '@pinpoint/shared';
import { SyntheticCardSource } from '../../engine/cards.js';
import { makeRng } from '../../engine/rng.js';
import { checkInvariants } from '../../engine/__tests__/harness.js';
import { RoomManager } from '../rooms.js';
import { attachSocketServer } from '../server.js';

let httpServer: HttpServer;
let io: Server;
let port: number;
let rooms: RoomManager;

const GRACE_MS = 80;

beforeEach(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { path: SOCKET_PATH });
  rooms = new RoomManager(new SyntheticCardSource(makeRng(42)));
  attachSocketServer(io as never, rooms, { disconnectGraceMs: GRACE_MS });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterEach(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const tick = () => new Promise((r) => setTimeout(r, 25));
const pastGrace = () => new Promise((r) => setTimeout(r, GRACE_MS + 60));

class Client {
  socket: ClientSocket;
  pub: PublicRoom | null = null;
  priv: PrivateState | null = null;
  playerId = '';
  token = '';
  name: string;

  constructor(name: string) {
    this.name = name;
    this.socket = ioc(`http://localhost:${port}`, { path: SOCKET_PATH, forceNew: true });
    this.socket.on('room:state', (s: PublicRoom) => (this.pub = s));
    this.socket.on('you:state', (s: PrivateState) => (this.priv = s));
  }
  emit<T>(event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => this.socket.emit(event, payload, resolve));
  }
  connected(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.connected) resolve();
      else this.socket.on('connect', () => resolve());
    });
  }
  close() {
    this.socket.disconnect();
  }
}

function checkRoomInvariants(code: string) {
  const runtime = rooms.get(code);
  if (runtime) checkInvariants(runtime.engine);
}

/** Stand up a room and join `n` players with plain names P0..P{n-1}. First is host. */
async function seatPlayers(n: number): Promise<{ code: string; host: Client; all: Client[] }> {
  const host = new Client('P0');
  await host.connected();
  const created = await host.emit<{ code: string }>('host:create', { canCast: true });
  expect(created.ok).toBe(true);
  const code = created.ok ? created.data.code : '';
  host.socket.emit('host:castStatus', { connected: true });

  const all: Client[] = [host];
  for (let i = 0; i < n; i++) {
    const c = i === 0 ? host : new Client(`P${i}`);
    if (i > 0) await c.connected();
    const r = await c.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName: c.name,
      canCast: i === 0,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) {
      c.playerId = r.data.playerId;
      c.token = r.data.reconnectToken;
    }
    if (i > 0) all.push(c);
  }
  await tick();
  checkRoomInvariants(code);
  return { code, host, all };
}

const byId = (all: Client[], id: string) => all.find((c) => c.playerId === id)!;

/** Drive exactly one full round (WRITE_CLUES through ROUND_END or GAME_OVER). */
async function playOneRound(code: string, host: Client, all: Client[]): Promise<void> {
  expect(host.pub?.phase).toBe('WRITE_CLUES');
  const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
  for (const id of insiderIds) {
    const c = byId(all, id);
    expect(c.priv?.isInsider, `${c.name} should see isInsider`).toBe(true);
    expect(c.priv?.card).not.toBeNull();
    c.socket.emit('clues:choose', { optionIndex: 0 });
    for (const slot of ['A', 'B', 'C'] as const) {
      c.socket.emit('clues:setClue', { slot, clue: `w${slot}` });
    }
    const s = await c.emit('clues:submit', {});
    expect(s.ok, JSON.stringify(s)).toBe(true);
  }
  await tick();
  checkRoomInvariants(code);

  for (let phase = 0; phase < 2; phase++) {
    if (host.pub?.phase !== 'GUESS_FIRST' && host.pub?.phase !== 'GUESS_SECOND') break;
    const g = host.pub?.round?.activeGuessing;
    if (!g) break;
    const insider = byId(all, g.insiderPlayerId);
    // always resolve on the first spoken guess (CORRECT) so games terminate quickly
    const fr = await insider.emit('guess:flip', { slot: 'A' });
    expect(fr.ok, JSON.stringify(fr)).toBe(true);
    const rr = await insider.emit('guess:result', { result: 'CORRECT' });
    expect(rr.ok, JSON.stringify(rr)).toBe(true);
    await tick();
    checkRoomInvariants(code);
    if (host.pub?.phase === 'GAME_OVER') return;
  }
}

/** Play rounds until GAME_OVER, calling round:next between them. */
async function playToGameOver(code: string, host: Client, all: Client[], maxRounds = 40): Promise<void> {
  let rounds = 0;
  while (host.pub?.phase !== 'GAME_OVER') {
    await playOneRound(code, host, all);
    if (host.pub?.phase === 'GAME_OVER') break;
    expect(host.pub?.phase, JSON.stringify(host.pub)).toBe('ROUND_END');
    const nr = await host.emit('round:next', {});
    expect(nr.ok).toBe(true);
    await tick();
    checkRoomInvariants(code);
    if (++rounds > maxRounds) throw new Error('game never terminated');
  }
}

describe('user simulation: 6 games, varied player counts and real-world edge cases', () => {
  it('game 1 — 3 players (THREE_PLAYER mode): sloppy names, full game, then a rematch', async () => {
    const host = new Client('  Alex  ');
    await host.connected();
    const created = await host.emit<{ code: string }>('host:create', { canCast: true });
    const code = created.ok ? created.data.code : '';
    host.socket.emit('host:castStatus', { connected: true });
    const hj = await host.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName: '  Alex  ', // leading/trailing whitespace a real user types on a phone keyboard
      canCast: true,
    });
    expect(hj.ok).toBe(true);
    if (hj.ok) host.playerId = hj.data.playerId;
    await tick();
    // whitespace should be trimmed for display and for dupe-checking
    expect(host.pub?.players[0]?.displayName).toBe('Alex');

    // a case-insensitive duplicate name must be rejected
    const dupe = new Client('dupe');
    await dupe.connected();
    const dupeJoin = await dupe.emit('room:join', { code, displayName: 'ALEX' });
    expect(dupeJoin.ok).toBe(false);
    dupe.close();

    const others: Client[] = [];
    for (const name of ['Bree', 'Cody']) {
      const c = new Client(name);
      await c.connected();
      const r = await c.emit<{ playerId: string; reconnectToken: string }>('room:join', {
        code,
        displayName: name,
      });
      expect(r.ok).toBe(true);
      if (r.ok) c.playerId = r.data.playerId;
      others.push(c);
    }
    const all = [host, ...others];
    await tick();
    checkRoomInvariants(code);

    const start = await host.emit('lobby:start', {});
    expect(start.ok, JSON.stringify(start)).toBe(true);
    await tick();
    expect(host.pub?.mode).toBe('THREE_PLAYER');
    await playToGameOver(code, host, all);
    expect(host.pub?.winnerPlayerIds.length).toBeGreaterThanOrEqual(1);

    // rematch with the same 3 players, then play a full second game —
    // regression coverage for the rematch mode/state reset bug.
    const rematch = await host.emit('host:rematch', {});
    expect(rematch.ok, JSON.stringify(rematch)).toBe(true);
    await tick();
    expect(host.pub?.phase).toBe('LOBBY');
    for (const p of host.pub?.players ?? []) {
      expect(p.tokensFlipped).toBe(0);
    }
    const restart = await host.emit('lobby:start', {});
    expect(restart.ok, JSON.stringify(restart)).toBe(true);
    await tick();
    expect(host.pub?.mode).toBe('THREE_PLAYER');
    await playToGameOver(code, host, all);

    for (const c of all) c.close();
  }, 20000);

  it('game 2 — 4 players: a player disconnects for good mid-round; host removes them and the game continues', async () => {
    const { code, host, all } = await seatPlayers(4);
    const start = await host.emit('lobby:start', {});
    expect(start.ok, JSON.stringify(start)).toBe(true);
    await tick();

    // a non-host player, so the host stays connected to perform the removal
    const victim = all.find((c) => c !== host)!;
    victim.close();
    await pastGrace();
    expect(host.pub?.phase).toBe('PAUSED');
    expect(host.pub?.pause.waitingForPlayerId).toBe(victim.playerId);

    // a non-host, and the wrong host-check target, cannot remove the player
    const notHost = all.find((c) => c !== host && c !== victim)!;
    const denied = await notHost.emit('host:removePlayer', { playerId: victim.playerId });
    expect(denied.ok).toBe(false);

    const removed = await host.emit('host:removePlayer', { playerId: victim.playerId });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    await tick();
    checkRoomInvariants(code);
    expect(host.pub?.players.some((p) => p.id === victim.playerId)).toBe(false);
    // the game should have un-paused and resumed the round it was in
    expect(host.pub?.phase).not.toBe('PAUSED');

    const remaining = all.filter((c) => c !== victim);
    await playToGameOver(code, host, remaining, 60);
    for (const c of remaining) c.close();
  }, 20000);

  it('game 3 — 5 players: a 6th joins mid-round (queued, then active), settings locked once started', async () => {
    const { code, host, all } = await seatPlayers(5);
    // settings can be changed pre-start... ('lobby:settings' has no ack; fire-and-forget)
    host.socket.emit('lobby:settings', { difficulty: 'HARD' });
    await tick();
    expect(host.pub?.settings.difficulty).toBe('HARD');

    const start = await host.emit('lobby:start', {});
    expect(start.ok).toBe(true);
    await tick();

    // ...but not mid-game
    host.socket.emit('lobby:settings', { difficulty: 'EASY' });
    await tick();
    expect(host.pub?.settings.difficulty).toBe('HARD');

    const latecomer = new Client('Late');
    await latecomer.connected();
    const lr = await latecomer.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName: 'Late',
    });
    expect(lr.ok, JSON.stringify(lr)).toBe(true);
    if (lr.ok) latecomer.playerId = lr.data.playerId;
    await tick();
    checkRoomInvariants(code);
    const lp = host.pub?.players.find((p) => p.id === latecomer.playerId);
    expect(lp?.pendingJoin).toBe(true);
    expect(lp?.teamId).not.toBeNull(); // TEAM mode: pre-assigned even while queued

    const all2 = [...all, latecomer];
    await playOneRound(code, host, all2); // finishes the round the latecomer joined mid-way
    if (host.pub?.phase === 'ROUND_END') {
      await host.emit('round:next', {});
      await tick();
    }
    checkRoomInvariants(code);
    const lp2 = host.pub?.players.find((p) => p.id === latecomer.playerId);
    expect(lp2?.pendingJoin).toBe(false); // now active

    for (const c of all2) c.close();
  }, 20000);

  it('game 4 — 6 players: casual mode, hard difficulty, random rotation, timers off, full game', async () => {
    const { code, host, all } = await seatPlayers(6);
    host.socket.emit('lobby:settings', {
      casualMode: true,
      timersEnabled: false,
      rotationMode: 'RANDOM',
      difficulty: 'HARD',
    });
    await tick();
    expect(host.pub?.settings.casualMode).toBe(true);
    expect(host.pub?.settings.timersEnabled).toBe(false);

    const start = await host.emit('lobby:start', {});
    expect(start.ok, JSON.stringify(start)).toBe(true);
    await tick();
    expect(host.pub?.timer.phaseDeadline).toBeNull(); // timers off -> no deadline ever set

    await playToGameOver(code, host, all, 60);
    expect(host.pub?.winnerTeamId).not.toBeNull();
    for (const c of all) c.close();
  }, 20000);

  it('game 5 — 7 players: a brief tab-background blip does not pause, a real drop does and then resumes', async () => {
    const { code, host, all } = await seatPlayers(7);
    const start = await host.emit('lobby:start', {});
    expect(start.ok).toBe(true);
    await tick();

    const wanderer = all[1]!;
    const token = wanderer.token;
    wanderer.close();
    await tick(); // well within the grace window
    expect(host.pub?.phase).not.toBe('PAUSED');

    const back = new Client(wanderer.name);
    await back.connected();
    const rr = await back.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName: wanderer.name,
      reconnectToken: token,
    });
    expect(rr.ok, JSON.stringify(rr)).toBe(true);
    if (rr.ok) {
      back.playerId = rr.data.playerId;
      back.token = rr.data.reconnectToken;
    }
    await pastGrace(); // if the grace timer weren't cancelled on reconnect it would fire around now
    expect(host.pub?.phase).not.toBe('PAUSED');

    // now a real drop, past the grace window, during guessing
    const idx = all.indexOf(wanderer);
    all[idx] = back;
    // advance into a guessing phase before dropping someone
    const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
    for (const id of insiderIds) {
      const c = byId(all, id);
      c.socket.emit('clues:choose', { optionIndex: 0 });
      for (const slot of ['A', 'B', 'C'] as const) c.socket.emit('clues:setClue', { slot, clue: `w${slot}` });
      await c.emit('clues:submit', {});
    }
    await tick();
    expect(host.pub?.phase).toBe('GUESS_FIRST');

    const dropped = all.find((c) => c !== host && c.playerId !== insiderIds[0])!;
    const dropToken = dropped.token;
    dropped.close();
    await pastGrace();
    expect(host.pub?.phase).toBe('PAUSED');
    checkRoomInvariants(code);

    const rejoin = new Client(dropped.name);
    await rejoin.connected();
    const rj = await rejoin.emit('room:join', { code, displayName: dropped.name, reconnectToken: dropToken });
    expect(rj.ok, JSON.stringify(rj)).toBe(true);
    await tick();
    expect(host.pub?.phase).toBe('GUESS_FIRST'); // resumed exactly where it paused
    checkRoomInvariants(code);

    for (const c of [...all.filter((c) => c !== dropped), rejoin]) c.close();
  }, 20000);

  it('game 6 — 8 players: a player disconnects for good; rematch must not carry stale tokens/team onto them', async () => {
    const { code, host, all } = await seatPlayers(8);
    const start = await host.emit('lobby:start', {});
    expect(start.ok).toBe(true);
    await tick();

    // play one full round so someone accrues tokens, then drop a non-host player for good
    await playOneRound(code, host, all);
    if (host.pub?.phase === 'ROUND_END') {
      await host.emit('round:next', {});
      await tick();
    }
    const ghost = all.find((c) => c !== host)!;
    ghost.close();
    await pastGrace();
    expect(host.pub?.phase).toBe('PAUSED');

    // host force-ends rather than waiting forever, then calls a rematch
    // without removing the ghost first (a real host might not notice).
    // ('host:forceEnd' has no ack; fire-and-forget)
    host.socket.emit('host:forceEnd', {});
    await tick();
    expect(host.pub?.phase).toBe('GAME_OVER');

    const rematch = await host.emit('host:rematch', {});
    expect(rematch.ok, JSON.stringify(rematch)).toBe(true);
    await tick();
    checkRoomInvariants(code);

    const ghostPub = host.pub?.players.find((p) => p.id === ghost.playerId);
    expect(ghostPub).toBeDefined();
    expect(ghostPub?.tokensFlipped).toBe(0);
    expect(ghostPub?.teamId).toBeNull(); // unassigned, not silently left on a stale team

    // remaining 7 connected players can still start (7 -> valid TEAM split)
    const remaining = all.filter((c) => c !== ghost);
    const restart = await host.emit('lobby:start', {});
    expect(restart.ok, JSON.stringify(restart)).toBe(true);
    await tick();
    await playToGameOver(code, host, remaining, 60);

    for (const c of remaining) c.close();
  }, 20000);
});
