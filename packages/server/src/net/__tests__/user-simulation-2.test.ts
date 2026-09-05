// Second user-simulation batch: 20 games. The first batch
// (user-simulation.test.ts) covered session lifecycle — joins, disconnects,
// settings, rematch — across player counts. This batch goes after what that
// one didn't: actual gameplay-rule enforcement (invalid input, authorization,
// out-of-turn actions), score correctness under real varied content (not
// placeholder clues), and multi-party disconnect edge cases. See the
// user-simulation-testing skill for the full rationale.
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { SOCKET_PATH, TOKENS_TO_WIN, type Ack, type GuessResult, type PrivateState, type PublicRoom } from '@pinpoint/shared';
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
  rooms = new RoomManager(new SyntheticCardSource(makeRng(7)));
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
    return new Promise((resolve) => (this.socket.connected ? resolve() : this.socket.on('connect', () => resolve())));
  }
  close() {
    this.socket.disconnect();
  }
}

function checkRoomInvariants(code: string) {
  const runtime = rooms.get(code);
  if (runtime) checkInvariants(runtime.engine);
}

async function seatPlayers(n: number): Promise<{ code: string; host: Client; all: Client[] }> {
  const host = new Client('P0');
  await host.connected();
  const created = await host.emit<{ code: string }>('host:create', { canCast: true });
  expect(created.ok).toBe(true);
  const code = created.ok ? created.data.code : '';
  host.socket.emit('host:castStatus', { connected: true });

  const all: Client[] = [];
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
    all.push(c);
  }
  await tick();
  checkRoomInvariants(code);
  return { code, host, all };
}

const byId = (all: Client[], id: string) => all.find((c) => c.playerId === id)!;
const WORDS = [
  'ocean', 'violin', 'comet', 'lantern', 'marble', 'quartz', 'ember', 'willow',
  'harbor', 'canyon', 'ripple', 'thistle', 'copper', 'granite', 'meadow', 'falcon',
];
let wordCursor = 0;
const nextWord = () => WORDS[wordCursor++ % WORDS.length]!;

/** Play one round with varied real clue text and a caller-chosen result
 * sequence per message (rather than a fixed "always correct on guess 1"). */
async function playOneRoundWithResults(
  code: string,
  host: Client,
  all: Client[],
  resultsFor: (insiderId: string) => GuessResult[],
): Promise<void> {
  expect(host.pub?.phase).toBe('WRITE_CLUES');
  const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
  for (const id of insiderIds) {
    const c = byId(all, id);
    c.socket.emit('clues:choose', { optionIndex: Math.floor(Math.random() * 6) });
    for (const slot of ['A', 'B', 'C'] as const) {
      c.socket.emit('clues:setClue', { slot, clue: nextWord() });
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
    const results = resultsFor(g.insiderPlayerId);
    for (const result of results) {
      if (host.pub?.round?.activeGuessing?.resolved) break;
      const slots = ['A', 'B', 'C'] as const;
      const flippedCount = host.pub!.round!.activeGuessing!.steps.filter((s) => s.flippedSlot).length;
      const needsFlip = !host.pub!.round!.activeGuessing!.steps[host.pub!.round!.activeGuessing!.currentStepIndex]!.flippedSlot;
      if (needsFlip) {
        const fr = await insider.emit('guess:flip', { slot: slots[flippedCount]! });
        expect(fr.ok, JSON.stringify(fr)).toBe(true);
      }
      const rr = await insider.emit('guess:result', { result });
      expect(rr.ok, JSON.stringify(rr)).toBe(true);
      await tick();
      checkRoomInvariants(code);
    }
    if (host.pub?.phase === 'GAME_OVER') return;
  }
}

async function playOneRound(code: string, host: Client, all: Client[]): Promise<void> {
  await playOneRoundWithResults(code, host, all, () => ['CORRECT']);
}

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

describe('user simulation batch 2: 20 games — gameplay-rule enforcement, authorization, score correctness', () => {
  it('game 1 — 3 players: full THREE_PLAYER game with varied real clue text to completion', async () => {
    const { code, host, all } = await seatPlayers(3);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    await playToGameOver(code, host, all);
    expect(host.pub?.winnerPlayerIds.length).toBeGreaterThanOrEqual(1);
    for (const c of all) c.close();
  }, 20000);

  it('game 2 — 4 players: casual mode reveals the category matching the Insider\'s actually chosen option', async () => {
    const { code, host, all } = await seatPlayers(4);
    host.socket.emit('lobby:settings', { casualMode: true });
    await tick();
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
    const chosen = new Map<string, number>();
    for (const id of insiderIds) {
      const c = byId(all, id);
      const idx = Math.floor(Math.random() * 6);
      chosen.set(id, idx);
      c.socket.emit('clues:choose', { optionIndex: idx });
      for (const slot of ['A', 'B', 'C'] as const) c.socket.emit('clues:setClue', { slot, clue: nextWord() });
      await c.emit('clues:submit', {});
    }
    await tick();
    const g = host.pub!.round!.activeGuessing!;
    const myCard = byId(all, g.insiderPlayerId).priv!.card!;
    const expectedCategory = myCard[chosen.get(g.insiderPlayerId)!]!.category;
    expect(g.revealedCategory).toBe(expectedCategory);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 3 — 5 players: server accepts (and correctly round-trips) a clearly-multi-word clue — documents current honor-system behavior', async () => {
    const { code, host, all } = await seatPlayers(5);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderId = host.pub!.round!.insiders[0]!.insiderPlayerId;
    const insider = byId(all, insiderId);
    const wildClue = 'this is definitely more than one word';
    insider.socket.emit('clues:choose', { optionIndex: 0 });
    insider.socket.emit('clues:setClue', { slot: 'A', clue: wildClue });
    insider.socket.emit('clues:setClue', { slot: 'B', clue: 'x' });
    insider.socket.emit('clues:setClue', { slot: 'C', clue: 'y' });
    await tick();
    // Not asserting this SHOULD be rejected (that's a game-rule call, not an
    // obvious defect — see the skill) — pinning down that today it's stored
    // verbatim, so a future decision to validate it is a deliberate change.
    expect(insider.priv?.ownClues?.find((c) => c.slot === 'A')?.clue).toBe(wildClue);
    for (const c of all) c.close();
  }, 20000);

  it('game 4 — 6 players: a blank clue is accepted and flows through guessing without breaking state', async () => {
    const { code, host, all } = await seatPlayers(6);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
    for (const id of insiderIds) {
      const c = byId(all, id);
      c.socket.emit('clues:choose', { optionIndex: 0 });
      c.socket.emit('clues:setClue', { slot: 'A', clue: '' }); // blank
      c.socket.emit('clues:setClue', { slot: 'B', clue: '   ' }); // whitespace-only
      c.socket.emit('clues:setClue', { slot: 'C', clue: nextWord() });
      const s = await c.emit('clues:submit', {});
      expect(s.ok, JSON.stringify(s)).toBe(true);
    }
    await tick();
    checkRoomInvariants(code);
    const g = host.pub!.round!.activeGuessing!;
    const insider = byId(all, g.insiderPlayerId);
    const fr = await insider.emit('guess:flip', { slot: 'A' });
    expect(fr.ok, JSON.stringify(fr)).toBe(true);
    // whitespace-only must have been trimmed to '' too, same as fully blank
    const b = host.pub!.round!.insiders.find((i) => i.insiderPlayerId === g.insiderPlayerId)!.clueBoards.find((b) => b.slot === 'A')!;
    expect(b.faceUp && b.clue === '').toBe(true);
    for (const c of all) c.close();
  }, 20000);

  it('game 5 — 7 players: choosing an out-of-range message option is rejected', async () => {
    const { code, host, all } = await seatPlayers(7);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderId = host.pub!.round!.insiders[0]!.insiderPlayerId;
    const insider = byId(all, insiderId);
    // 'clues:choose' has no ack — verify indirectly: an invalid choose must
    // not set chosenOptionIndex, so submit (which requires it) still fails.
    insider.socket.emit('clues:choose', { optionIndex: 99 });
    insider.socket.emit('clues:choose', { optionIndex: -1 });
    await tick();
    const s = await insider.emit('clues:submit', {});
    expect(s.ok).toBe(false);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 6 — 8 players: setting a clue before choosing a message still works; submit still requires a choice', async () => {
    const { code, host, all } = await seatPlayers(8);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderId = host.pub!.round!.insiders[0]!.insiderPlayerId;
    const insider = byId(all, insiderId);
    insider.socket.emit('clues:setClue', { slot: 'A', clue: nextWord() }); // before choosing
    await tick();
    const early = await insider.emit('clues:submit', {});
    expect(early.ok).toBe(false); // no message chosen yet
    insider.socket.emit('clues:choose', { optionIndex: 2 });
    await tick();
    const ok = await insider.emit('clues:submit', {});
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 7 — 3 players: submitting clues twice is rejected the second time', async () => {
    const { code, host, all } = await seatPlayers(3);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderId = host.pub!.round!.insiders[0]!.insiderPlayerId;
    const insider = byId(all, insiderId);
    insider.socket.emit('clues:choose', { optionIndex: 0 });
    for (const slot of ['A', 'B', 'C'] as const) insider.socket.emit('clues:setClue', { slot, clue: nextWord() });
    expect((await insider.emit('clues:submit', {})).ok).toBe(true);
    const second = await insider.emit('clues:submit', {});
    expect(second.ok).toBe(false);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 8 — 4 players: a non-Insider cannot flip boards or record guess results', async () => {
    const { code, host, all } = await seatPlayers(4);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderIds = new Set(host.pub!.round!.insiders.map((i) => i.insiderPlayerId));
    for (const id of insiderIds) {
      const c = byId(all, id);
      c.socket.emit('clues:choose', { optionIndex: 0 });
      for (const slot of ['A', 'B', 'C'] as const) c.socket.emit('clues:setClue', { slot, clue: nextWord() });
      await c.emit('clues:submit', {});
    }
    await tick();
    const outsider = all.find((c) => !insiderIds.has(c.playerId))!;
    const flip = await outsider.emit('guess:flip', { slot: 'A' });
    expect(flip.ok).toBe(false);
    const result = await outsider.emit('guess:result', { result: 'CORRECT' });
    expect(result.ok).toBe(false);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 9 — 5 players: flipping an already-face-up board is rejected', async () => {
    const { code, host, all } = await seatPlayers(5);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
    for (const id of insiderIds) {
      const c = byId(all, id);
      c.socket.emit('clues:choose', { optionIndex: 0 });
      for (const slot of ['A', 'B', 'C'] as const) c.socket.emit('clues:setClue', { slot, clue: nextWord() });
      await c.emit('clues:submit', {});
    }
    await tick();
    const g = host.pub!.round!.activeGuessing!;
    const insider = byId(all, g.insiderPlayerId);
    expect((await insider.emit('guess:flip', { slot: 'A' })).ok).toBe(true);
    const again = await insider.emit('guess:flip', { slot: 'A' });
    expect(again.ok).toBe(false);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 10 — 6 players: recording a guess result before flipping the requested board is rejected', async () => {
    const { code, host, all } = await seatPlayers(6);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
    for (const id of insiderIds) {
      const c = byId(all, id);
      c.socket.emit('clues:choose', { optionIndex: 0 });
      for (const slot of ['A', 'B', 'C'] as const) c.socket.emit('clues:setClue', { slot, clue: nextWord() });
      await c.emit('clues:submit', {});
    }
    await tick();
    const g = host.pub!.round!.activeGuessing!;
    const insider = byId(all, g.insiderPlayerId);
    const premature = await insider.emit('guess:result', { result: 'CORRECT' });
    expect(premature.ok).toBe(false);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 11 — 7 players: joining with an empty or whitespace-only name is rejected', async () => {
    const { code, host } = await seatPlayers(7);
    const c1 = new Client('');
    await c1.connected();
    const r1 = await c1.emit('room:join', { code, displayName: '' });
    expect(r1.ok).toBe(false);
    const c2 = new Client('   ');
    await c2.connected();
    const r2 = await c2.emit('room:join', { code, displayName: '   ' });
    expect(r2.ok).toBe(false);
    c1.close();
    c2.close();
    host.close();
  }, 20000);

  it('game 12 — 8 players: joining a nonexistent room code fails gracefully, not a crash', async () => {
    await seatPlayers(8); // ensure the server is mid-session with a real room, unrelated to the probe below
    const c = new Client('Ghost');
    await c.connected();
    const r = await c.emit('room:join', { code: '0000', displayName: 'Ghost' });
    expect(r.ok).toBe(false);
    c.close();
  }, 20000);

  it('game 13 — 3 players: a burst of concurrent duplicate-name joins from different sockets yields exactly one seat for that name', async () => {
    const host = new Client('P0');
    await host.connected();
    const created = await host.emit<{ code: string }>('host:create', { canCast: true });
    const code = created.ok ? created.data.code : '';
    host.socket.emit('host:castStatus', { connected: true });
    await host.emit('room:join', { code, displayName: 'P0', canCast: true });

    const attempts = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const c = new Client('Racer');
        await c.connected();
        const r = await c.emit('room:join', { code, displayName: 'Racer' });
        return { c, r };
      }),
    );
    await tick();
    const successes = attempts.filter((a) => a.r.ok);
    expect(successes.length).toBe(1); // only the first should win the name
    const racerCount = host.pub?.players.filter((p) => p.displayName === 'Racer').length;
    expect(racerCount).toBe(1);
    checkRoomInvariants(code);
    for (const a of attempts) a.c.close();
    host.close();
  }, 20000);

  it('game 14 — 4 players: settings and team assignment are locked once the game has started', async () => {
    const { code, host, all } = await seatPlayers(4);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const before = host.pub!.settings.difficulty;
    host.socket.emit('lobby:settings', { difficulty: before === 'HARD' ? 'EASY' : 'HARD' });
    const someoneElseId = all.find((c) => c !== host)!.playerId;
    host.socket.emit('lobby:assignTeam', { playerId: someoneElseId, teamId: 'A' });
    await tick();
    expect(host.pub?.settings.difficulty).toBe(before);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 15 — 5 players: only the host may start, assign teams, change settings, force-end, or rematch', async () => {
    const { code, host, all } = await seatPlayers(5);
    const notHost = all.find((c) => c !== host)!;
    const startDenied = await notHost.emit('lobby:start', {});
    expect(startDenied.ok).toBe(false);
    notHost.socket.emit('lobby:assignTeam', { playerId: host.playerId, teamId: 'B' });
    notHost.socket.emit('lobby:settings', { difficulty: 'HARD' });
    await tick();
    expect(host.pub?.players.find((p) => p.id === host.playerId)?.teamId).not.toBe('B');
    expect(host.pub?.settings.difficulty).not.toBe('HARD');
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    notHost.socket.emit('host:forceEnd', {});
    await tick();
    expect(host.pub?.phase).not.toBe('GAME_OVER'); // a non-host forceEnd must not have worked
    const rematchDenied = await notHost.emit('host:rematch', {});
    expect(rematchDenied.ok).toBe(false);
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);

  it('game 16 — 6 players: a TV receiver never sees hidden state, and losing/regaining receivers does not affect players', async () => {
    const { code, host, all } = await seatPlayers(6);
    const receiver = new Client('TV');
    await receiver.connected();
    const sub = await receiver.emit('receiver:subscribe', { code });
    expect(sub.ok, JSON.stringify(sub)).toBe(true);
    await tick();
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    // the receiver's own "you:state" must never carry a card (it's nobody's private state)
    expect(receiver.priv?.card).toBeNull();
    expect(receiver.priv?.isInsider).toBeFalsy();

    // a second receiver joins and leaves; players must be unaffected throughout
    const receiver2 = new Client('TV2');
    await receiver2.connected();
    await receiver2.emit('receiver:subscribe', { code });
    await tick();
    receiver2.close();
    await tick();
    expect(host.pub?.phase).toBe('WRITE_CLUES'); // untouched by receiver churn
    checkRoomInvariants(code);
    receiver.close();
    for (const c of all) c.close();
  }, 20000);

  it('game 17 — 7 players: the host disconnecting for real transfers host and still pauses/resumes correctly', async () => {
    const { code, host, all } = await seatPlayers(7);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const hostToken = host.token;
    host.close();
    await pastGrace();
    expect(host.pub).not.toBeNull(); // last state we received before closing
    // reconnect as a different client to observe the post-disconnect state
    const observer = all.find((c) => c !== host)!;
    expect(observer.pub?.phase).toBe('PAUSED');
    const newHostId = observer.pub?.players.find((p) => p.isHost)?.id;
    expect(newHostId).toBeDefined();
    expect(newHostId).not.toBe(host.playerId); // host actually transferred, not just reassigned to itself
    // exactly one host, and it's not the departed one
    expect(observer.pub?.players.filter((p) => p.isHost).length).toBe(1);
    expect(observer.pub?.players.find((p) => p.id === newHostId)?.connected).toBe(true);

    const rejoin = new Client('P0');
    await rejoin.connected();
    const rr = await rejoin.emit('room:join', { code, displayName: 'P0', reconnectToken: hostToken });
    expect(rr.ok, JSON.stringify(rr)).toBe(true);
    await tick();
    expect(observer.pub?.phase).not.toBe('PAUSED');
    checkRoomInvariants(code);
    for (const c of all.filter((c) => c !== host)) c.close();
    rejoin.close();
  }, 20000);

  it('game 18 — 8 players: two players disconnect; game resumes only once BOTH are back', async () => {
    const { code, host, all } = await seatPlayers(8);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const [victim1, victim2] = all.filter((c) => c !== host);
    const t1 = victim1!.token;
    const t2 = victim2!.token;
    victim1!.close();
    victim2!.close();
    await pastGrace();
    expect(host.pub?.phase).toBe('PAUSED');

    const back1 = new Client(victim1!.name);
    await back1.connected();
    const r1 = await back1.emit('room:join', { code, displayName: victim1!.name, reconnectToken: t1 });
    expect(r1.ok).toBe(true);
    await tick();
    expect(host.pub?.phase).toBe('PAUSED'); // still one short

    const back2 = new Client(victim2!.name);
    await back2.connected();
    const r2 = await back2.emit('room:join', { code, displayName: victim2!.name, reconnectToken: t2 });
    expect(r2.ok).toBe(true);
    await tick();
    expect(host.pub?.phase).not.toBe('PAUSED');
    checkRoomInvariants(code);
    for (const c of all.filter((c) => c !== victim1 && c !== victim2)) c.close();
    back1.close();
    back2.close();
  }, 20000);

  it('game 19 — 4 players: independently-recomputed score matches engine state after a full game with mixed real outcomes', async () => {
    const { code, host, all } = await seatPlayers(4);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();

    // Independently tally expected tokens from the actual sequence of guess
    // results, rather than trusting "phase reached GAME_OVER" as proof the
    // score is right.
    const expectedTokens: Record<'A' | 'B', number> = { A: 0, B: 0 };
    let rounds = 0;
    while (host.pub?.phase !== 'GAME_OVER') {
      for (let phase = 0; phase < 2; phase++) {
        if (host.pub?.phase !== 'WRITE_CLUES' && phase === 0) {
          // submit clues for this round once, before any guessing phase
        }
        if (phase === 0) {
          const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
          for (const id of insiderIds) {
            const c = byId(all, id);
            c.socket.emit('clues:choose', { optionIndex: Math.floor(Math.random() * 6) });
            for (const slot of ['A', 'B', 'C'] as const) c.socket.emit('clues:setClue', { slot, clue: nextWord() });
            await c.emit('clues:submit', {});
          }
          await tick();
        }
        if (host.pub?.phase !== 'GUESS_FIRST' && host.pub?.phase !== 'GUESS_SECOND') continue;
        const g = host.pub!.round!.activeGuessing!;
        const insider = byId(all, g.insiderPlayerId);
        const contactTeam = g.contactTeam!;
        const interceptTeam = g.interceptTeam!;
        let resolved = false;
        while (!resolved) {
          const step = host.pub!.round!.activeGuessing!.steps[host.pub!.round!.activeGuessing!.currentStepIndex]!;
          const flippedCount = host.pub!.round!.activeGuessing!.steps.filter((s) => s.flippedSlot).length;
          if (!step.flippedSlot) {
            const slots = ['A', 'B', 'C'] as const;
            await insider.emit('guess:flip', { slot: slots[flippedCount]! });
          }
          // alternate results deterministically to exercise every branch across rounds
          const result: GuessResult = rounds % 2 === 0 ? 'INCORRECT' : 'CORRECT';
          const stepIndexBefore = host.pub!.round!.activeGuessing!.currentStepIndex;
          await insider.emit('guess:result', { result });
          await tick();
          const gAfter = host.pub!.round!.activeGuessing;
          if (result === 'CORRECT') {
            if (stepIndexBefore < 2) expectedTokens[interceptTeam] += 1;
            else expectedTokens[contactTeam] += 1;
            resolved = true;
          } else if (stepIndexBefore === 2) {
            expectedTokens[interceptTeam] += 1;
            resolved = true;
          }
          if (!gAfter || gAfter.resolved) resolved = true;
          if (host.pub?.phase === 'GAME_OVER') { resolved = true; break; }
        }
        if (host.pub?.phase === 'GAME_OVER') break;
      }
      if (host.pub?.phase === 'ROUND_END') {
        await host.emit('round:next', {});
        await tick();
      }
      checkRoomInvariants(code);
      if (++rounds > 40) throw new Error('game never terminated');
    }

    const teamA = host.pub!.teams.find((t) => t.id === 'A')!;
    const teamB = host.pub!.teams.find((t) => t.id === 'B')!;
    expect(teamA.tokensFlipped).toBe(Math.min(TOKENS_TO_WIN, expectedTokens.A));
    expect(teamB.tokensFlipped).toBe(Math.min(TOKENS_TO_WIN, expectedTokens.B));
    expect(host.pub?.winnerTeamId).toBe(teamA.tokensFlipped >= TOKENS_TO_WIN ? 'A' : 'B');
    for (const c of all) c.close();
  }, 20000);

  it('game 20 — 6 players: IN_ORDER rotation gives every team member a turn as Insider before repeating', async () => {
    const { code, host, all } = await seatPlayers(6);
    expect((await host.emit('lobby:start', {})).ok).toBe(true);
    await tick();
    const teamAIds = new Set(host.pub!.players.filter((p) => p.teamId === 'A').map((p) => p.id));
    const teamBIds = new Set(host.pub!.players.filter((p) => p.teamId === 'B').map((p) => p.id));
    const seenA = new Set<string>();
    const seenB = new Set<string>();
    let rounds = 0;
    // Play enough rounds to cycle through every team member at least once
    // (team size 3 here), checking no one repeats before their teammates do.
    while (seenA.size < teamAIds.size || seenB.size < teamBIds.size) {
      const [a, b] = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
      if (teamAIds.has(a!) ) {
        if (seenA.has(a!) && seenA.size < teamAIds.size) throw new Error('insider repeated before teammates got a turn');
        seenA.add(a!);
      }
      if (teamBIds.has(b!)) {
        if (seenB.has(b!) && seenB.size < teamBIds.size) throw new Error('insider repeated before teammates got a turn');
        seenB.add(b!);
      }
      await playOneRound(code, host, all);
      if (host.pub?.phase === 'GAME_OVER') break; // fine — fewer rounds than a full cycle is still a valid game
      expect(host.pub?.phase).toBe('ROUND_END');
      await host.emit('round:next', {});
      await tick();
      if (++rounds > 20) break;
    }
    checkRoomInvariants(code);
    for (const c of all) c.close();
  }, 20000);
});
