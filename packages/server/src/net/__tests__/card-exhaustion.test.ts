// Regression coverage for a real production incident (see
// .claude/investigations/01f4093566c5b945.md): the AI card generator's
// buffer can run dry (upstream API unavailable, credits exhausted, etc.).
// Before this fix, GameEngine.beginRound() threw a plain Error when the
// card source returned null instead of a card — and that throw happened
// synchronously inside a Socket.IO event handler with no try/catch anywhere
// above it, which would crash the *entire* server process (every concurrent
// room, not just the one that ran out of cards) on the very next
// `lobby:start` or `round:next`. This drives that exact path over a real
// socket connection and asserts the server survives and answers a clear,
// retriable error instead.
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { SOCKET_PATH, type Ack, type Difficulty, type MessageCard, type PublicRoom, type PrivateState } from '@pinpoint/shared';
import type { CardSource } from '../../engine/cards.js';
import { RoomManager } from '../rooms.js';
import { attachSocketServer } from '../server.js';

/** Deals fine, then goes dry for `dryCalls` deals, then recovers — like an
 * AI buffer that runs out and later refills. */
class FlakyCardSource implements CardSource {
  private calls = 0;
  constructor(
    private readonly goodCallsBeforeDry: number,
    private readonly dryCalls: number,
  ) {}
  deal(_difficulty: Difficulty, _excludeNormalized: ReadonlySet<string>): MessageCard | null {
    this.calls += 1;
    if (this.calls > this.goodCallsBeforeDry && this.calls <= this.goodCallsBeforeDry + this.dryCalls) {
      return null;
    }
    return {
      id: `c${this.calls}`,
      options: (['C', 'M', 'P', 'L', 'B', 'W'] as const).map((category) => ({
        category,
        text: `${category}${this.calls}`,
      })),
    };
  }
}

let httpServer: HttpServer;
let io: Server;
let port: number;

beforeEach(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { path: SOCKET_PATH });
});
afterEach(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

class Client {
  socket: ClientSocket;
  pub: PublicRoom | null = null;
  priv: PrivateState | null = null;
  playerId = '';
  constructor() {
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

const tick = () => new Promise((r) => setTimeout(r, 30));

async function seat4(): Promise<{ code: string; host: Client; all: Client[] }> {
  const host = new Client();
  await host.connected();
  const created = await host.emit<{ code: string }>('host:create', { canCast: true });
  const code = created.ok ? created.data.code : '';
  host.socket.emit('host:castStatus', { connected: true });
  const hj = await host.emit<{ playerId: string }>('room:join', { code, displayName: 'Host', canCast: true });
  if (hj.ok) host.playerId = hj.data.playerId;
  const others: Client[] = [];
  for (let i = 1; i < 4; i++) {
    const c = new Client();
    await c.connected();
    const r = await c.emit<{ playerId: string }>('room:join', { code, displayName: `P${i}` });
    if (r.ok) c.playerId = r.data.playerId;
    others.push(c);
  }
  await tick();
  return { code, host, all: [host, ...others] };
}

async function finishRound(host: Client, all: Client[]): Promise<void> {
  const byId = (id: string) => all.find((c) => c.playerId === id)!;
  const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
  for (const id of insiderIds) {
    const c = byId(id);
    c.socket.emit('clues:choose', { optionIndex: 0 });
    for (const slot of ['A', 'B', 'C'] as const) c.socket.emit('clues:setClue', { slot, clue: 'x' });
    await c.emit('clues:submit', {});
  }
  await tick();
  for (let phase = 0; phase < 2; phase++) {
    if (host.pub?.phase !== 'GUESS_FIRST' && host.pub?.phase !== 'GUESS_SECOND') break;
    const g = host.pub!.round!.activeGuessing!;
    const insider = byId(g.insiderPlayerId);
    await insider.emit('guess:flip', { slot: 'A' });
    await insider.emit('guess:result', { result: 'CORRECT' });
    await tick();
  }
}

describe('card source exhaustion mid-game does not crash the server', () => {
  it('round:next fails gracefully while dry, then succeeds once the source recovers', async () => {
    // Round 1 needs 2 deals (TEAM mode, 2 insiders). beginRound() aborts on
    // the *first* failing deal without attempting the second insider, so
    // one dry call is enough to fail round 2's first attempt; the very next
    // call (the retry) then succeeds.
    const rooms = new RoomManager(new FlakyCardSource(2, 1));
    attachSocketServer(io as never, rooms, { disconnectGraceMs: 50 });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as { port: number }).port;

    const { host, all } = await seat4();
    const start = await host.emit('lobby:start', {});
    expect(start.ok, JSON.stringify(start)).toBe(true);
    await tick();
    await finishRound(host, all);
    expect(host.pub?.phase).toBe('ROUND_END');

    // Round 2: card source is dry -> should fail as an ordinary ack error,
    // not crash, and the room stays put in ROUND_END so it can be retried.
    const failed = await host.emit('round:next', {});
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toMatch(/no messages available/i);
    await tick();
    expect(host.pub?.phase).toBe('ROUND_END');

    // The server must still be fully alive and answering unrelated clients.
    const probe = new Client();
    await probe.connected();
    const probeCreate = await probe.emit<{ code: string }>('host:create', { canCast: true });
    expect(probeCreate.ok, 'server must survive card-source exhaustion').toBe(true);
    probe.close();

    // The source has recovered now — a retry of the exact same action succeeds.
    const retry = await host.emit('round:next', {});
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    await tick();
    expect(host.pub?.phase).toBe('WRITE_CLUES');

    for (const c of all) c.close();
  }, 20000);
});
