// ============================================================================
// Wire protocol: socket event names + intent/payload shapes shared by client
// and server. Clients send *intents*; the server validates, mutates the
// authoritative state, and broadcasts projections (see projection.ts).
// ============================================================================
import type {
  BoardSlot,
  Difficulty,
  GuessResult,
  RotationMode,
  TeamId,
} from './types.js';
import type { PublicRoom, PrivateState } from './projection.js';

// ---------- Client -> Server intents ----------
export interface ClientToServer {
  /** Host: create a room. Server generates code, returns it via host:created. */
  'host:create': (
    payload: { canCast: boolean },
    ack: (res: Ack<{ code: string }>) => void,
  ) => void;

  /** Host: report cast session connected/disconnected for their room. */
  'host:castStatus': (payload: { connected: boolean }) => void;

  /** Join a room (lobby or mid-game). reconnectToken optional (reclaim seat). */
  'room:join': (
    payload: {
      code: string;
      displayName: string;
      reconnectToken?: string;
      canCast?: boolean;
    },
    ack: (res: Ack<{ playerId: string; reconnectToken: string }>) => void,
  ) => void;

  /** TV receiver subscribes read-only to a room. */
  'receiver:subscribe': (
    payload: { code: string },
    ack: (res: Ack<{}>) => void,
  ) => void;

  /** TV receiver: no room code yet, wait for host to cast. */
  'receiver:standby': (_: {}) => void;

  /** Host moves a player to a team in the lobby. */
  'lobby:assignTeam': (payload: { playerId: string; teamId: TeamId }) => void;
  /** Host updates room settings in the lobby. */
  'lobby:settings': (payload: Partial<{
    casualMode: boolean;
    timersEnabled: boolean;
    rotationMode: RotationMode;
    difficulty: Difficulty;
  }>) => void;
  /** Host starts the game. */
  'lobby:start': (_: {}, ack: (res: Ack<{}>) => void) => void;

  /** Insider picks one of the 6 options. */
  'clues:choose': (payload: { optionIndex: number }) => void;
  /** Insider sets a clue word for a board slot. */
  'clues:setClue': (payload: { slot: BoardSlot; clue: string }) => void;
  /** Insider submits their 3 clues. */
  'clues:submit': (_: {}, ack: (res: Ack<{}>) => void) => void;

  /** Insider flips the board the guessers requested. */
  'guess:flip': (payload: { slot: BoardSlot }, ack: (res: Ack<{}>) => void) => void;
  /** Insider records the spoken guess result. */
  'guess:result': (payload: { result: GuessResult }, ack: (res: Ack<{}>) => void) => void;

  /** Advance from ROUND_END to next round. */
  'round:next': (_: {}, ack: (res: Ack<{}>) => void) => void;

  /** Player flags the current card option as bad. */
  'card:flag': (payload: { reason?: string }) => void;

  /** Host force-ends or restarts. */
  'host:forceEnd': (_: {}) => void;
  'host:rematch': (_: {}, ack: (res: Ack<{}>) => void) => void;
}

// ---------- Server -> Client events ----------
export interface ServerToClient {
  /** Host room created. */
  'host:created': (payload: { code: string }) => void;
  /** Full public room projection (broadcast to all clients in the room). */
  'room:state': (payload: PublicRoom) => void;
  /** Per-socket private state (your seat, your card if insider, your clues). */
  'you:state': (payload: PrivateState) => void;
  /** Room closed / no longer exists. */
  'room:closed': (payload: { reason: string }) => void;
  /** Generic non-fatal error toast. */
  'error': (payload: { message: string }) => void;

  /** Server pushes room code to a standby receiver when the host casts. */
  'cast:roomCode': (payload: { code: string }) => void;
}

export type Ack<T> = { ok: true; data: T } | { ok: false; error: string };

export const SOCKET_PATH = '/socket';
