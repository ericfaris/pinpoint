// Socket.IO wiring: clients send intents, the server validates via the engine
// and broadcasts spectator-safe projections. Also schedules phase timers.
import type { Server, Socket } from 'socket.io';
import {
  CLUE_WRITE_SECONDS,
  type Ack,
  type ClientToServer,
  type ServerToClient,
} from '@triangulation/shared';
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

export function attachSocketServer(io: IO, rooms: RoomManager): void {
  const data = (s: Sock) => s.data as SocketData;

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
        runtime.timer = null;
        const res = runtime.engine.clueTimerExpired();
        if (res.ok) broadcast(runtime);
      }, delay + 20);
    }
  }

  function runtimeForSocket(s: Sock): RoomRuntime | undefined {
    const code = data(s).code;
    return code ? rooms.get(code) : undefined;
  }

  io.on('connection', (socket: Sock) => {
    // ---- Host creates a room (cast handshake happens client-side first) ----
    socket.on('host:create', (payload, ack) => {
      try {
        const runtime = rooms.create();
        data(socket).code = runtime.engine.room.code;
        socket.join(runtime.engine.room.code);
        socket.emit('host:created', { code: runtime.engine.room.code });
        ack(okAck({ code: runtime.engine.room.code }));
      } catch (e) {
        ack(errAck((e as Error).message));
      }
    });

    socket.on('host:castStatus', ({ connected }) => {
      const runtime = runtimeForSocket(socket);
      if (!runtime) return;
      runtime.engine.setCastConnected(connected);
      broadcast(runtime);
    });

    // ---- Join (lobby or mid-game; reconnect via token) ----
    socket.on('room:join', ({ code, displayName, reconnectToken, canCast }, ack) => {
      const runtime = rooms.get(code);
      if (!runtime) return ack(errAck('Room not found.'));
      const res = runtime.engine.join({ displayName, reconnectToken, canCast });
      if (!res.ok) return ack(errAck(res.error));
      data(socket).code = code;
      data(socket).playerId = res.player.id;
      runtime.sockets.set(socket.id, res.player.id);
      socket.join(code);
      ack(okAck({ playerId: res.player.id, reconnectToken: res.player.reconnectToken }));
      broadcast(runtime);
    });

    // ---- TV receiver subscribes read-only ----
    socket.on('receiver:subscribe', ({ code }, ack) => {
      const runtime = rooms.get(code);
      if (!runtime) return ack(errAck('Room not found.'));
      data(socket).code = code;
      data(socket).isReceiver = true;
      runtime.receivers.add(socket.id);
      socket.join(code);
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

    socket.on('lobby:assignTeam', ({ playerId, teamId }) => {
      withRuntimeHost((rt, hostId) => rt.engine.assignTeam(hostId, playerId, teamId));
    });
    socket.on('lobby:settings', (patch) => {
      withRuntimeHost((rt, hostId) => rt.engine.updateSettings(hostId, patch));
    });
    socket.on('lobby:start', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const playerId = data(socket).playerId;
      if (!runtime || !playerId) return ack(errAck('Not in a room.'));
      const res = runtime.engine.start(playerId);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Clue writing ----
    socket.on('clues:choose', ({ optionIndex }) => {
      withRuntimeHost((rt, pid) => rt.engine.chooseOption(pid, optionIndex));
    });
    socket.on('clues:setClue', ({ slot, clue }) => {
      withRuntimeHost((rt, pid) => rt.engine.setClue(pid, slot, clue));
    });
    socket.on('clues:submit', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.submitClues(pid);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Guessing ----
    socket.on('guess:flip', ({ slot }, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.flip(pid, slot);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });
    socket.on('guess:result', ({ result }, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.recordResult(pid, result);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Round / host powers ----
    socket.on('round:next', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.nextRound(pid);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });
    socket.on('card:flag', () => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return;
      const flagged = runtime.engine.flagCard(pid);
      if (flagged.ok && flagged.option) {
        console.log(`[flag] room ${runtime.engine.room.code}:`, flagged.option);
      }
    });
    socket.on('host:forceEnd', () => {
      withRuntimeHost((rt, hostId) => rt.engine.forceEnd(hostId));
    });
    socket.on('host:rematch', (_payload, ack) => {
      const runtime = runtimeForSocket(socket);
      const pid = data(socket).playerId;
      if (!runtime || !pid) return ack(errAck('Not in a room.'));
      const res = runtime.engine.rematch(pid);
      if (!res.ok) return ack(errAck(res.error));
      ack(okAck({}));
      broadcast(runtime);
    });

    // ---- Disconnect ----
    socket.on('disconnect', () => {
      const code = data(socket).code;
      if (!code) return;
      const runtime = rooms.get(code);
      if (!runtime) return;
      if (data(socket).isReceiver) {
        runtime.receivers.delete(socket.id);
      } else {
        const playerId = runtime.sockets.get(socket.id);
        runtime.sockets.delete(socket.id);
        if (playerId) runtime.engine.disconnect(playerId);
      }
      if (!rooms.closeIfEmpty(code)) broadcast(runtime);
    });
  });
}

export { CLUE_WRITE_SECONDS };
