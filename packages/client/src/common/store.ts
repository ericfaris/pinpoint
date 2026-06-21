// Socket client + tiny observable store shared by player and receiver UIs.
import { io, type Socket } from 'socket.io-client';
import {
  SOCKET_PATH,
  type Ack,
  type BoardSlot,
  type Difficulty,
  type GuessResult,
  type PrivateState,
  type PublicRoom,
  type RotationMode,
  type TeamId,
} from '@triangulation/shared';

export interface GameState {
  connected: boolean;
  pub: PublicRoom | null;
  priv: PrivateState | null;
  code: string | null;
  error: string | null;
  /** client_now - server_now at last projection, to reconcile timer deadlines */
  serverOffset: number;
}

type Listener = () => void;

const LS_CODE = 'tri:code';
const LS_TOKEN = 'tri:token';
const LS_NAME = 'tri:name';

class GameStore {
  private socket: Socket;
  private listeners = new Set<Listener>();
  state: GameState = {
    connected: false,
    pub: null,
    priv: null,
    code: null,
    error: null,
    serverOffset: 0,
  };

  constructor() {
    this.socket = io({ path: SOCKET_PATH, autoConnect: true });
    this.socket.on('connect', () => this.patch({ connected: true }));
    this.socket.on('disconnect', () => this.patch({ connected: false }));
    this.socket.on('room:state', (pub: PublicRoom) =>
      this.patch({ pub, serverOffset: Date.now() - pub.serverNow }),
    );
    this.socket.on('you:state', (priv: PrivateState) => this.patch({ priv }));
    this.socket.on('host:created', ({ code }: { code: string }) => this.patch({ code }));
    this.socket.on('error', ({ message }: { message: string }) => this.patch({ error: message }));
    this.socket.on('room:closed', () => this.patch({ pub: null, priv: null, error: 'Room closed.' }));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private patch(p: Partial<GameState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }
  private emit<T>(event: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) =>
      this.socket.emit(event, payload, (ack: Ack<T>) => resolve(ack)),
    );
  }

  setError(error: string | null) {
    this.patch({ error });
  }

  // ---- saved identity for reconnection (§4.8) ----
  savedCode(): string | null {
    return localStorage.getItem(LS_CODE);
  }
  savedToken(): string | null {
    return localStorage.getItem(LS_TOKEN);
  }
  savedName(): string | null {
    return localStorage.getItem(LS_NAME);
  }
  clearSaved() {
    localStorage.removeItem(LS_CODE);
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_NAME);
  }

  // ---- host ----
  async hostCreate(canCast: boolean): Promise<string | null> {
    const res = await this.emit<{ code: string }>('host:create', { canCast });
    if (res.ok) {
      this.patch({ code: res.data.code });
      return res.data.code;
    }
    this.patch({ error: res.error });
    return null;
  }
  castStatus(connected: boolean) {
    this.socket.emit('host:castStatus', { connected });
  }

  // ---- join ----
  async join(code: string, displayName: string, canCast = false): Promise<boolean> {
    const token = this.savedToken() ?? undefined;
    const reconnectToken = this.savedCode() === code ? token : undefined;
    const res = await this.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName,
      reconnectToken,
      canCast,
    });
    if (res.ok) {
      localStorage.setItem(LS_CODE, code);
      localStorage.setItem(LS_TOKEN, res.data.reconnectToken);
      localStorage.setItem(LS_NAME, displayName);
      this.patch({ code, error: null });
      return true;
    }
    this.patch({ error: res.error });
    return false;
  }

  // ---- lobby ----
  assignTeam(playerId: string, teamId: TeamId) {
    this.socket.emit('lobby:assignTeam', { playerId, teamId });
  }
  updateSettings(patch: Partial<{
    casualMode: boolean;
    timersEnabled: boolean;
    rotationMode: RotationMode;
    difficulty: Difficulty;
  }>) {
    this.socket.emit('lobby:settings', patch);
  }
  async start(): Promise<boolean> {
    const res = await this.emit('lobby:start', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }

  // ---- clues ----
  choose(optionIndex: number) {
    this.socket.emit('clues:choose', { optionIndex });
  }
  setClue(slot: BoardSlot, clue: string) {
    this.socket.emit('clues:setClue', { slot, clue });
  }
  async submit(): Promise<boolean> {
    const res = await this.emit('clues:submit', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }

  // ---- guessing ----
  async flip(slot: BoardSlot): Promise<boolean> {
    const res = await this.emit('guess:flip', { slot });
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  async result(result: GuessResult): Promise<boolean> {
    const res = await this.emit('guess:result', { result });
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }

  // ---- round / host powers ----
  async nextRound(): Promise<boolean> {
    const res = await this.emit('round:next', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }
  flagCard() {
    this.socket.emit('card:flag', {});
  }
  forceEnd() {
    this.socket.emit('host:forceEnd', {});
  }
  async rematch(): Promise<boolean> {
    const res = await this.emit('host:rematch', {});
    if (!res.ok) this.patch({ error: res.error });
    return res.ok;
  }

  // ---- receiver ----
  async receiverSubscribe(code: string): Promise<boolean> {
    const res = await this.emit('receiver:subscribe', { code });
    if (res.ok) this.patch({ code });
    else this.patch({ error: res.error });
    return res.ok;
  }
}

export const store = new GameStore();
