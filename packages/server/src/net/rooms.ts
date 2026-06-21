// Room registry: owns the map of 4-digit code -> GameEngine, handles collision-
// checked code generation (§4.1.2), and frees codes when rooms close.
import { GameEngine } from '../engine/engine.js';
import type { CardSource } from '../engine/cards.js';
import { makeRng } from '../engine/rng.js';

export interface RoomRuntime {
  engine: GameEngine;
  /** socketId -> playerId for player/host sockets in this room */
  sockets: Map<string, string>;
  /** receiver (TV) socketIds */
  receivers: Set<string>;
  /** active phase timer handle */
  timer: NodeJS.Timeout | null;
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly rng = makeRng();

  constructor(private readonly cardSource: CardSource) {}

  has(code: string): boolean {
    return this.rooms.has(code);
  }
  get(code: string): RoomRuntime | undefined {
    return this.rooms.get(code);
  }
  all(): RoomRuntime[] {
    return [...this.rooms.values()];
  }

  private generateCode(): string {
    // up to 10k codes; rooms are short-lived so collisions are rare but checked.
    for (let attempt = 0; attempt < 100000; attempt++) {
      const code = String(this.rng.int(10000)).padStart(4, '0');
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('No free room codes available.');
  }

  create(): RoomRuntime {
    const code = this.generateCode();
    const engine = new GameEngine(code, { cardSource: this.cardSource });
    const runtime: RoomRuntime = {
      engine,
      sockets: new Map(),
      receivers: new Set(),
      timer: null,
    };
    this.rooms.set(code, runtime);
    return runtime;
  }

  close(code: string): void {
    const r = this.rooms.get(code);
    if (r?.timer) clearTimeout(r.timer);
    this.rooms.delete(code);
  }

  /** Close a room if it has no connected players or receivers (§4.1.2 reuse). */
  closeIfEmpty(code: string): boolean {
    const r = this.rooms.get(code);
    if (!r) return false;
    const anyConnected = r.engine.room.players.some((p) => p.connected);
    if (!anyConnected && r.receivers.size === 0) {
      this.close(code);
      return true;
    }
    return false;
  }
}
