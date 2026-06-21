// Test harness: a controllable clock + helpers to build engines and drive
// full games, plus an invariant checker run after every mutation.
import { expect } from 'vitest';
import {
  TOKENS_TO_WIN,
  type BoardSlot,
  type GameRoom,
} from '@triangulation/shared';
import { GameEngine } from '../engine.js';
import { SyntheticCardSource, normalizeText } from '../cards.js';
import { makeRng } from '../rng.js';
import { toPrivateState, toPublicRoom } from '../project.js';

export class Clock {
  t = 1_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export function makeEngine(seed: number): { engine: GameEngine; clock: Clock } {
  const clock = new Clock();
  const rng = makeRng(seed);
  const engine = new GameEngine('1234', {
    rng,
    cardSource: new SyntheticCardSource(makeRng(seed + 7)),
    now: clock.now,
  });
  engine.setCastConnected(true);
  return { engine, clock };
}

export interface Seat {
  id: string;
  token: string;
  name: string;
}

/** Add `n` players to the lobby. The first becomes host. Returns their seats. */
export function addPlayers(engine: GameEngine, n: number, canCast = true): Seat[] {
  const seats: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const name = `P${i}`;
    const res = engine.join({ displayName: name, canCast: i === 0 ? canCast : false });
    if (!res.ok) throw new Error(`join failed: ${res.error}`);
    seats.push({ id: res.player.id, token: res.player.reconnectToken, name });
  }
  return seats;
}

// ---------------------------------------------------------------- invariants
export function checkInvariants(engine: GameEngine, prevTokens?: Map<string, number>): Map<string, number> {
  const room = engine.room;
  const tokens = new Map<string, number>();

  // token bounds + monotonic
  for (const t of room.teams) {
    expect(t.tokensFlipped).toBeGreaterThanOrEqual(0);
    expect(t.tokensFlipped).toBeLessThanOrEqual(TOKENS_TO_WIN);
    tokens.set(`team:${t.id}`, t.tokensFlipped);
  }
  for (const p of room.players) {
    expect(p.tokensFlipped).toBeGreaterThanOrEqual(0);
    expect(p.tokensFlipped).toBeLessThanOrEqual(TOKENS_TO_WIN);
    tokens.set(`player:${p.id}`, p.tokensFlipped);
  }
  if (prevTokens) {
    for (const [k, v] of tokens) {
      const prev = prevTokens.get(k);
      if (prev !== undefined) expect(v).toBeGreaterThanOrEqual(prev);
    }
  }

  // exactly one host (unless room empty)
  if (room.players.length > 0) {
    expect(room.players.filter((p) => p.isHost).length).toBe(1);
  }

  // unique display names (case-insensitive)
  const names = room.players.map((p) => p.displayName.toLowerCase());
  expect(new Set(names).size).toBe(names.length);

  // guessing structural invariants + spectator-safe leak check
  const g = room.round?.activeGuessing;
  if (g && !g.resolved) {
    expect(g.currentStepIndex).toBeGreaterThanOrEqual(0);
    expect(g.currentStepIndex).toBeLessThanOrEqual(2);
    const ins = room.round!.insiders.find((i) => i.insiderPlayerId === g.insiderPlayerId)!;
    const faceUp = ins.clueBoards.filter((b) => b.faceUp).length;
    expect(faceUp).toBeLessThanOrEqual(3);
    // number of face-up boards equals number of steps that recorded a flip
    const flips = g.steps.slice(0, g.currentStepIndex + 1).filter((s) => s.flippedSlot).length;
    expect(faceUp).toBe(flips);
  }

  // spectator-safe: public projection must never leak a facedown clue word,
  // and a non-Insider's private state must never carry card options.
  const pub = toPublicRoom(room, engine.room.createdAt);
  for (const insPub of pub.round?.insiders ?? []) {
    for (const b of insPub.clueBoards) {
      if (!b.faceUp) expect(b.clue).toBeNull();
    }
  }
  for (const p of room.players) {
    const priv = toPrivateState(engine, p.id);
    if (!engine.isInsiderNow(p.id)) {
      expect(priv.card).toBeNull();
      expect(priv.ownClues).toBeNull();
    }
  }

  // served-message dedupe: no duplicates ever
  const served = [...room.servedMessages];
  expect(new Set(served).size).toBe(served.length);

  return tokens;
}

// ---------------------------------------------------------- game driver
export interface PlayOptions {
  /** probability a guess is judged CORRECT (drives game length/branching) */
  correctProb?: number;
  maxRounds?: number;
  /** if set, vary submit order so different insiders finish first */
  rng?: () => number;
}

/** Drive one insider through choosing a message + writing clues. */
function writeClues(engine: GameEngine, insiderId: string, rand: () => number): void {
  const r = engine.chooseOption(insiderId, Math.floor(rand() * 6));
  expect(r.ok).toBe(true);
  const slots: BoardSlot[] = ['A', 'B', 'C'];
  for (const slot of slots) {
    engine.setClue(insiderId, slot, `clue_${slot}_${Math.floor(rand() * 1000)}`);
  }
  const s = engine.submitClues(insiderId);
  expect(s.ok).toBe(true);
}

/** Play a single message's guessing sequence to resolution. */
function playGuessing(engine: GameEngine, rand: () => number, correctProb: number): void {
  let guard = 0;
  while (true) {
    const room = engine.room;
    if (room.phase !== 'GUESS_FIRST' && room.phase !== 'GUESS_SECOND') return;
    const g = room.round!.activeGuessing!;
    if (g.resolved) return;
    const ins = room.round!.insiders.find((i) => i.insiderPlayerId === g.insiderPlayerId)!;
    const step = g.steps[g.currentStepIndex]!;

    // flip a board if this step needs one (step 2 auto-reveals)
    if (!step.flippedSlot) {
      const facedown = ins.clueBoards.filter((b) => !b.faceUp);
      expect(facedown.length).toBeGreaterThan(0);
      const pick = facedown[Math.floor(rand() * facedown.length)]!;
      const fr = engine.flip(g.insiderPlayerId, pick.slot);
      expect(fr.ok).toBe(true);
    }

    const result = rand() < correctProb ? 'CORRECT' : 'INCORRECT';
    const rr = engine.recordResult(g.insiderPlayerId, result);
    expect(rr.ok).toBe(true);
    checkInvariants(engine);

    if (++guard > 10) throw new Error('guessing did not resolve');
  }
}

/** Play a full game to completion. Returns number of rounds played. */
export function playFullGame(engine: GameEngine, hostId: string, opts: PlayOptions = {}): number {
  const rand = opts.rng ?? Math.random;
  const correctProb = opts.correctProb ?? 0.5;
  const maxRounds = opts.maxRounds ?? 200;
  let rounds = 0;

  while ((engine.room.phase as string) !== 'GAME_OVER') {
    expect(engine.room.phase).toBe('WRITE_CLUES');
    const insiders = engine.room.round!.insiders.map((i) => i.insiderPlayerId);
    // vary order so first-submitter varies
    const order = insiders.slice().sort(() => rand() - 0.5);
    for (const id of order) writeClues(engine, id, rand);
    checkInvariants(engine);

    // GUESS_FIRST then (TEAM) GUESS_SECOND, each resolved internally
    playGuessing(engine, rand, correctProb);
    if (engine.room.phase === 'GUESS_SECOND') playGuessing(engine, rand, correctProb);

    if (engine.room.phase === 'GAME_OVER') break;
    expect(engine.room.phase).toBe('ROUND_END');
    const nr = engine.nextRound(hostId);
    expect(nr.ok).toBe(true);
    checkInvariants(engine);

    if (++rounds > maxRounds) throw new Error('game did not terminate');
  }
  return rounds;
}
