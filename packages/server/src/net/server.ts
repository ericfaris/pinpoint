// Socket.IO wiring: clients send intents, the server validates via the engine
// and broadcasts spectator-safe projections. Also schedules phase timers.
import type { Server, Socket } from 'socket.io';
import {
  CLUE_WRITE_SECONDS,
  type Ack,
  type ClientToServer,
  type ServerToClient,
} from '@pinpoint/shared';
import { toPrivateState, toPublicRoom } from '../engine/project.js';
import type { RoomManager, RoomRuntime } from './rooms.js';

type IO = Server<ClientToServer, ServerToClient>;
type Sock = Socket<ClientToServer, ServerToClient>;

interface SocketData {
  code?: string;
  playerId?: string;
  isReceiver?: boolean;
}

const okAck = <T>(data: T): Ack<T> => ({ ok: true, data });
const errAck = (error: string): Ack<never> => ({ ok: false, error });

// How long a disconnected player gets before it actually pauses the game.
// A background tab / brief network drop looks identical to a real
// disconnect at the socket level; assume it's temporary and stay silent
// about it unless it outlasts this window. Combined with the ~60s Socket.IO
// pingTimeout (index.ts) before a drop even registers, that's a ~2min
// total tolerance for a player to wander off and come back unnoticed.
// Overridable so tests don't have to burn real seconds to exercise this path.
const DEFAULT_DISCONNECT_GRACE_MS = 60_000;

export function attachSocketServer(
  io: IO,
  rooms: RoomManager,
  opts: { disconnectGraceMs?: number } = {},
): void {
  const disconnectGraceMs = opts.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
  const data = (s: Sock) => s.data as SocketData;
  const standbyReceivers = new Set<string>(); // socketIds waiting for a room code

  function broadcast(runtime: RoomRuntime): void {
    const now = Date.now();
    const pub = toPublicRoom(runtime.engine.room, now);
    // public state to everyone in the room (players + receivers)
    io.to(runtime.engine.room.code).emit('room:state', pub);
    // per-socket private state
    for (const [socketId, playerId] of runtime.sockets) {
      io.to(socketId).emit('you:state', toPrivateState(runtime.engine, playerId));
    }
    for (const socketId of runtime.receivers) {
      io.to(socketId).emit('you:state', toPrivateState(runtime.engine, null));
    }
    reconcileTimer(runtime);
  }

  /** Re-arm the single phase timer for a room based on current state. */
  function reconcileTimer(runtime: RoomRuntime): void {
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    const room = runtime.engine.room;
    // Only the clue-writing timer drives an automatic action (§4.10);
    // guessing timers are visual-only and need no server callback.
    if (room.phase === 'WRITE_CLUES' && room.timer.phaseDeadline) {
      const delay = Math.max(0, room.timer.phaseDeadline - Date.now());
      runtime.timer = setTimeout(() => {
        try {
          runtime.timer = null;
          const res = runtime.engine.clueTimerExpired();
          if (res.ok) broadcast(runtime);
        } catch (e) {
          console.error('[timer] clueTimerExpired threw:', e);
        }
      }, delay + 20);
    }
  }

  function runtimeForSocket(s: Sock): RoomRuntime | undefined {
    const code = data(s).code;
    return code ? rooms.get(code) : undefined;
  }

  io.on('connection', (socket: Sock) => {
    // Every intent handler below is wrapped so a thrown exception —
    // whether from a bug we haven't found yet, or a well-understood failure
    // mode like the card source running dry — turns into an error reply (or
    // is just logged, for fire-and-forget events) instead of propagating out
    // of a Socket.IO event dispatch and crashing the whole process. A single
    // room's bad luck must never take down every other concurrent game.
    const rawOn = socket.on.bind(socket);
    const on = <E extends keyof ClientToServer>(event: E, handler: ClientToServer[E]): void => {
      rawOn(event, ((...args: unknown[]) => {
        try {
          (handler as (...a: unknown[]) => void)(...args);
        } catch (e) {
          console.error(`[socket] ${String(event)} handler threw:`, e);
          const maybeAck = args[args.length - 1];
          if (typeof maybeAck === 'function') {
            try {
              (maybeAck as (r: Ack<never>) => void)(errAck('Something went wrong. Please try again.'));
            } catch {
              /* client already gone */
            }
          } else {
            socket.emit('error', { message: 'Something went wrong. Please try again.' });
          }
        }
      }) as never);
    };

    // ---- Host creates a room (cast handshake happens client-side first) ----
    on('host:create', (payload, ack) => {
      try {
        const runtime = rooms.create();
        const code = runtime.engine.room.code;
        console.log(`[room] ${code} created`);
        data(socket).code = code;
        socket.join(code);
        socket.emit('host:created', { code });
        if (payload.canCast) {
          rooms.setPendingCastCode(code);
          for (const sid of standbyReceivers) io.to(sid).emit('cast:roomCode', { code });
          standbyReceivers.clear();
        }
        ack(okAck({ code }));
      } catch (e) {
        ack(errAck((e as Error).message));
      }
    });

    on('host:castStatus', ({ connected }) => {
      const runtime = runtimeForSocket(socket);
      if (!runtime) return;
      runtime.engine.setCastConnected(connected);
      if (connected && standbyReceivers.size > 0) {
        const code = runtime.engine.room.code;
        for (const sid of standbyReceivers) {
          io.to(sid).emit('cast:roomCode', { code });
        }
        standbyReceivers.clear();
      }
      broadcast(runtime);
    });

    on('receiver:standby', () => {
      const code = rooms.getPendingCastCode();
      if (code) {
        io.to(socket.id).emit('cast:roomCode', { code });
      } else {
        standbyReceivers.add(socket.id);
      }
    });

    // ---- Join (lobby or mid-game; reconnect via token) ----
    on('room:join', ({ code, displayName, reconnectToken, canCast }, ack) => {
      const runtime = rooms.get(code);
      if (!runtime) return ack(errAck('Room not found.'));
      const res = runtime.engine.join({ displayName, reconnectToken, canCast });
      if (!res.ok) return ack(errAck(res.error));
      // They're back — whether or not the grace-period pause below ever
      // actually fired, don't let a stale delayed pause land on top of them.
      const pendingGrace = runtime.disconnectGraceTimers.get(res.player.id);
      if (pendingGrace) {
        clearTimeout(pendingGrace);
        runtime.disconnectGraceTimers.delete(res.player.id);
      }
      data(socket).code = code;
      data(socket).playerId = res.player.id;
      runtime.sockets.set(socket.id, res.player.id);
      socket.join(code);
      ack(okAck({ playerId: res.player.id, reconnectToken: res.player.reconnectToken }));
      broadcast(runtime);
    });

    // ---- TV receiver subscribes read-only ----
    on('receiver:subscribe', ({ code }, ack) => {
      const runtime = rooms.get(code);
      if (!runtime) {
        console.log(`[receiver] subscribe to ${code} failed: room not found`);
        return ack(errAck('Room not found.'));
      }
      console.log(`[receiver] subscribed to ${code}`);
      data(socket).code = code;
      data(socket).isReceiver = true;
      runtime.receivers.add(socket.id);
      socket.join(code);
      runtime.engine.setCastConnected(true);
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Lobby config ----
    const withRuntimeHost = (fn: (rt: RoomRuntime, playerId: string) => void) => {
      const runtime = runtimeForSocket(socket);
      const playerId = data(socket).playerId;
      if (runtime && playerId) {
        fn(runtime, playerId);
        broadcast(runtime);
      }
    };

    on('lobby:assignTeam', ({ playerId, teamId }) => {
      withRuntimeHost((rt, hostId) => rt.engine.assignTeam(hostId, playerId, teamId));
    });
    on('lobby:settings', (patch) => {
      withRuntimeHost((rt, hostId) => rt.engine.updateSettings(hostId, patch));
    });
    on('lobby:start', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const playerId = data(socket).playerId;
      if (!runtime || !playerId) return ack(errAck('Not in a room.'));
      const res = runtime.engine.start(playerId);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Clue writing ----
    on('clues:choose', ({ optionIndex }) => {
      withRuntimeHost((rt, pid) => rt.engine.chooseOption(pid, optionIndex));
    });
    on('clues:setClue', ({ slot, clue }) => {
      withRuntimeHost((rt, pid) => rt.engine.setClue(pid, slot, clue));
    });
    on('clues:submit', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.submitClues(pid);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Guessing ----
    on('guess:flip', ({ slot }, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.flip(pid, slot);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });
    on('guess:result', ({ result }, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.recordResult(pid, result);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Round / host powers ----
    on('round:next', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.nextRound(pid);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });
    on('card:flag', () => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return;
      const flagged = runtime.engine.flagCard(pid);
      if (flagged.ok && flagged.option) {
        console.log(`[flag] room ${runtime.engine.room.code}:`, flagged.option);
      }
    });
    on('host:forceEnd', () => {
      withRuntimeHost((rt, hostId) => rt.engine.forceEnd(hostId));
    });
    on('host:rematch', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.rematch(pid);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });
    on('host:removePlayer', ({ playerId }, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.removePlayer(pid, playerId);
      if (!res.ok) return ack(errAck(res.error));
      runtime.sockets.forEach((otherPlayerId, socketId) => {
        if (otherPlayerId === playerId) runtime.sockets.delete(socketId);
      });
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Disconnect ----
    // Not a ClientToServer intent (it's a reserved Socket.IO event), so it's
    // outside the `on()` wrapper above — and its own body, plus the deferred
    // grace-period timer below, run with no ack to reply to. Guard both by
    // hand so an unexpected throw here (or in the timer callback, which runs
    // completely outside any Socket.IO dispatch and would otherwise crash
    // the process just as readily) is logged instead of fatal.
    socket.on('disconnect', () => {
      try {
        handleDisconnect();
      } catch (e) {
        console.error('[socket] disconnect handler threw:', e);
      }
    });

    function handleDisconnect(): void {
      standbyReceivers.delete(socket.id);
      const code = data(socket).code;
      if (!code) return;
      const runtime = rooms.get(code);
      if (!runtime) return;
      if (data(socket).isReceiver) {
        runtime.receivers.delete(socket.id);
        console.log(`[receiver] disconnected from ${code} (${runtime.receivers.size} receivers left)`);
        if (runtime.receivers.size === 0) runtime.engine.setCastConnected(false);
        if (rooms.closeIfEmpty(code)) {
          console.log(`[room] ${code} closed (empty)`);
        } else {
          broadcast(runtime);
        }
        return;
      }

      const playerId = runtime.sockets.get(socket.id);
      runtime.sockets.delete(socket.id);
      if (!playerId) return;

      // Don't pause the game the instant a socket drops — a backgrounded
      // tab or brief network blip looks identical to a real disconnect at
      // this level. Give them a window to reconnect silently (room:join
      // cancels this timer) before actually marking them disconnected.
      const existingGrace = runtime.disconnectGraceTimers.get(playerId);
      if (existingGrace) clearTimeout(existingGrace);
      const graceTimer = setTimeout(() => {
        try {
          runtime.disconnectGraceTimers.delete(playerId);
          if (rooms.get(code) !== runtime) return; // room was replaced/closed meanwhile
          runtime.engine.disconnect(playerId);
          if (rooms.closeIfEmpty(code)) {
            console.log(`[room] ${code} closed (empty)`);
          } else {
            broadcast(runtime);
          }
        } catch (e) {
          console.error('[socket] disconnect grace-timer callback threw:', e);
        }
      }, disconnectGraceMs);
      runtime.disconnectGraceTimers.set(playerId, graceTimer);
    }
  });
}

export { CLUE_WRITE_SECONDS };
