// Net-layer integration: boot the real Socket.IO server in-process and play
// full games over actual WebSockets, validating the wire protocol, broadcast
// projections, and ack flow.
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  SOCKET_PATH,
  type Ack,
  type PrivateState,
  type PublicRoom,
} from '@pinpoint/shared';
import { SyntheticCardSource } from '../../engine/cards.js';
import { makeRng } from '../../engine/rng.js';
import { RoomManager } from '../rooms.js';
import { attachSocketServer } from '../server.js';

let httpServer: HttpServer;
let io: Server;
let port: number;

beforeEach(async () => {
  httpServer = createServer();
  io = new Server(httpServer, { path: SOCKET_PATH });
  const rooms = new RoomManager(new SyntheticCardSource(makeRng(1)));
  attachSocketServer(io as never, rooms);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterEach(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** A test client wrapping a socket with the latest public + private state. */
class Client {
  socket: ClientSocket;
  pub: PublicRoom | null = null;
  priv: PrivateState | null = null;
  playerId = '';
  token = '';

  constructor() {
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

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('full game over WebSockets', () => {
  it('plays a 4-player TEAM game to a winner', async () => {
    const host = new Client();
    await host.connected();
    const created = await host.emit<{ code: string }>('host:create', { canCast: true });
    expect(created.ok).toBe(true);
    const code = created.ok ? created.data.code : '';
    host.socket.emit('host:castStatus', { connected: true });

    const hj = await host.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName: 'Host',
      canCast: true,
    });
    expect(hj.ok).toBe(true);
    if (hj.ok) {
      host.playerId = hj.data.playerId;
      host.token = hj.data.reconnectToken;
    }

    const others: Client[] = [];
    for (let i = 1; i < 4; i++) {
      const c = new Client();
      await c.connected();
      const r = await c.emit<{ playerId: string; reconnectToken: string }>('room:join', {
        code,
        displayName: `P${i}`,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        c.playerId = r.data.playerId;
        c.token = r.data.reconnectToken;
      }
      others.push(c);
    }
    const all = [host, ...others];
    await tick();

    expect(host.pub?.players).toHaveLength(4);

    const start = await host.emit('lobby:start', {});
    expect(start.ok, JSON.stringify(start)).toBe(true);
    await tick();
    expect(host.pub?.phase).toBe('WRITE_CLUES');

    const clientById = (id: string) => all.find((c) => c.playerId === id)!;

    let guard = 0;
    while (host.pub?.phase !== 'GAME_OVER' && guard++ < 60) {
      // WRITE_CLUES: each insider chooses + submits
      const insiderIds = host.pub!.round!.insiders.map((i) => i.insiderPlayerId);
      for (const id of insiderIds) {
        const c = clientById(id);
        // the insider must have received their private card
        expect(c.priv?.isInsider).toBe(true);
        expect(c.priv?.card).not.toBeNull();
        c.socket.emit('clues:choose', { optionIndex: 0 });
        for (const slot of ['A', 'B', 'C'] as const) {
          c.socket.emit('clues:setClue', { slot, clue: `w${slot}` });
        }
        await c.emit('clues:submit', {});
      }
      await tick();

      // guessing: drive each active message to resolution (always intercept guess 1 correct)
      for (let phase = 0; phase < 2; phase++) {
        const g = host.pub?.round?.activeGuessing;
        if (!g || (host.pub?.phase !== 'GUESS_FIRST' && host.pub?.phase !== 'GUESS_SECOND')) break;
        const insider = clientById(g.insiderPlayerId);
        await insider.emit('guess:flip', { slot: 'A' });
        await insider.emit('guess:result', { result: 'CORRECT' });
        await tick();
        if (host.pub?.phase === 'GAME_OVER') break;
      }

      if (host.pub?.phase === 'ROUND_END') {
        await host.emit('round:next', {});
        await tick();
      }
    }

    expect(host.pub?.phase).toBe('GAME_OVER');
    expect(host.pub?.winnerTeamId).not.toBeNull();

    // spectator-safe: a non-insider never receives card options
    for (const c of all) {
      if (!c.priv?.isInsider) expect(c.priv?.card).toBeNull();
    }

    for (const c of all) c.close();
  }, 20000);

  it('blocks start without an active cast connection', async () => {
    const host = new Client();
    await host.connected();
    const created = await host.emit<{ code: string }>('host:create', { canCast: true });
    const code = created.ok ? created.data.code : '';
    await host.emit('room:join', { code, displayName: 'Host', canCast: true });
    for (let i = 1; i < 4; i++) {
      const c = new Client();
      await c.connected();
      await c.emit('room:join', { code, displayName: `P${i}` });
    }
    await tick();
    // no castStatus sent -> start should fail
    const start = await host.emit('lobby:start', {});
    expect(start.ok).toBe(false);
    host.close();
  }, 20000);

  it('reconnects a dropped player by token and resumes', async () => {
    const host = new Client();
    await host.connected();
    const created = await host.emit<{ code: string }>('host:create', { canCast: true });
    const code = created.ok ? created.data.code : '';
    host.socket.emit('host:castStatus', { connected: true });
    await host.emit('room:join', { code, displayName: 'Host', canCast: true });
    const clients: Client[] = [];
    for (let i = 1; i < 4; i++) {
      const c = new Client();
      await c.connected();
      const r = await c.emit<{ playerId: string; reconnectToken: string }>('room:join', {
        code,
        displayName: `P${i}`,
      });
      if (r.ok) c.token = r.data.reconnectToken;
      clients.push(c);
    }
    await host.emit('lobby:start', {});
    await tick();
    expect(host.pub?.phase).toBe('WRITE_CLUES');

    const victim = clients[0]!;
    const token = victim.token;
    victim.close();
    await tick();
    expect(host.pub?.phase).toBe('PAUSED');

    const rejoin = new Client();
    await rejoin.connected();
    const rr = await rejoin.emit('room:join', { code, displayName: 'P1', reconnectToken: token });
    expect(rr.ok).toBe(true);
    await tick();
    expect(host.pub?.phase).toBe('WRITE_CLUES');

    host.close();
    for (const c of clients.slice(1)) c.close();
    rejoin.close();
  }, 20000);
});
