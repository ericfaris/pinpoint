// ============================================================================
// Pinpoint game engine — pure, server-authoritative state machine.
// One GameEngine instance owns exactly one GameRoom. Net/timer side effects
// live outside; this file is deterministic given { rng, cardSource, now }.
// ============================================================================
import {
  BOARD_SLOTS,
  CLUE_WRITE_SECONDS,
  GUESS_SECONDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  THREE_PLAYER_COUNT,
  TOKENS_TO_WIN,
  type BoardSlot,
  type Category,
  type GameRoom,
  type GuessResult,
  type GuessStep,
  type InsiderRoundState,
  type Player,
  type RoomPhase,
  type RoomSettings,
  type TeamId,
  type ThreePlayerRole,
} from '@pinpoint/shared';
import { normalizeText, type CardSource } from './cards.js';
import { makeRng, type Rng } from './rng.js';

export type EngineResult = { ok: true } | { ok: false; error: string };
const ok: EngineResult = { ok: true };
const err = (error: string): EngineResult => ({ ok: false, error });

const IN_PROGRESS_PHASES: RoomPhase[] = ['WRITE_CLUES', 'GUESS_FIRST', 'GUESS_SECOND', 'ROUND_END'];

export interface EngineDeps {
  rng?: Rng;
  cardSource: CardSource;
  now?: () => number;
}

export interface JoinInput {
  displayName: string;
  reconnectToken?: string;
  canCast?: boolean;
}
export type JoinResult =
  | { ok: true; player: Player; reconnected: boolean }
  | { ok: false; error: string };

let tokenSeq = 0;
function makeToken(): string {
  tokenSeq += 1;
  return `tok_${tokenSeq}_${Math.random().toString(36).slice(2, 10)}`;
}
let playerSeq = 0;
function makePlayerId(): string {
  playerSeq += 1;
  return `p_${playerSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_SETTINGS: RoomSettings = {
  casualMode: false,
  timersEnabled: true,
  rotationMode: 'IN_ORDER',
  difficulty: 'MEDIUM',
};

export class GameEngine {
  readonly room: GameRoom;
  private readonly rng: Rng;
  private readonly cardSource: CardSource;
  private readonly now: () => number;

  // rotation / seating bookkeeping (not part of the broadcastable model)
  private threeSeating: string[] = [];
  private threeInsiderIndex = -1;
  private pausedRemainingMs: number | null = null;
  private joinCounter = 0;

  constructor(code: string, deps: EngineDeps) {
    this.rng = deps.rng ?? makeRng();
    this.cardSource = deps.cardSource;
    this.now = deps.now ?? (() => Date.now());
    this.room = {
      code,
      mode: 'TEAM',
      phase: 'LOBBY',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      teams: [
        { id: 'A', tokensFlipped: 0 },
        { id: 'B', tokensFlipped: 0 },
      ],
      round: null,
      servedMessages: new Set<string>(),
      timer: { enabled: DEFAULT_SETTINGS.timersEnabled, phaseDeadline: null },
      pause: { active: false, reason: null, waitingForPlayerId: null },
      winnerTeamId: null,
      winnerPlayerIds: [],
      castConnected: false,
      createdAt: this.now(),
      phaseBeforePause: null,
    };
  }

  // ---------------------------------------------------------------- helpers
  private player(id: string): Player | undefined {
    return this.room.players.find((p) => p.id === id);
  }
  private host(): Player | undefined {
    return this.room.players.find((p) => p.isHost);
  }
  private isHost(id: string): boolean {
    return this.host()?.id === id;
  }
  /** players that actively participate this round (not queued mid-join) */
  private activePlayers(): Player[] {
    return this.room.players.filter((p) => !p.pendingJoin);
  }
  private teamPlayers(teamId: TeamId): Player[] {
    return this.activePlayers()
      .filter((p) => p.teamId === teamId)
      .sort((a, b) => a.joinOrder - b.joinOrder);
  }
  private team(id: TeamId) {
    return this.room.teams.find((t) => t.id === id)!;
  }
  private otherTeam(id: TeamId): TeamId {
    return id === 'A' ? 'B' : 'A';
  }

  // --------------------------------------------------------------- creation
  static create(code: string, deps: EngineDeps): GameEngine {
    return new GameEngine(code, deps);
  }

  // ------------------------------------------------------------------ join
  join(input: JoinInput): JoinResult {
    const { displayName, reconnectToken, canCast } = input;

    // Reconnect path: known token reclaims the same seat.
    if (reconnectToken) {
      const existing = this.room.players.find((p) => p.reconnectToken === reconnectToken);
      if (existing) {
        existing.connected = true;
        if (canCast !== undefined) existing.canHostCast = canCast;
        this.maybeResume();
        return { ok: true, player: existing, reconnected: true };
      }
    }

    const name = displayName.trim();
    if (!name) return { ok: false, error: 'Display name required.' };
    const dupe = this.room.players.some(
      (p) => p.displayName.toLowerCase() === name.toLowerCase(),
    );
    if (dupe) return { ok: false, error: 'That name is taken in this room.' };
    if (this.room.players.length >= MAX_PLAYERS) {
      return { ok: false, error: 'Room is full (8 players max).' };
    }

    const inProgress = IN_PROGRESS_PHASES.includes(this.room.phase) || this.room.phase === 'PAUSED';
    const noHostYet = !this.host();

    const player: Player = {
      id: makePlayerId(),
      reconnectToken: makeToken(),
      displayName: name,
      teamId: null,
      connected: true,
      isHost: noHostYet,
      canHostCast: canCast ?? false,
      hasBeenInsiderThisGame: false,
      pendingJoin: false,
      tokensFlipped: 0,
      joinOrder: this.joinCounter++,
    };

    if (!inProgress) {
      // Lobby join: auto-balance immediately.
      player.pendingJoin = false;
      this.room.players.push(player);
      this.autoAssignTeam(player);
    } else if (this.room.mode === 'THREE_PLAYER') {
      // 3-Player Mode has no teams: queue until the game ends (§4.1.3 #6).
      player.pendingJoin = true;
      player.teamId = null;
      this.room.players.push(player);
    } else {
      // Mid-game TEAM join: slot into smaller team, active next round.
      player.pendingJoin = true;
      this.room.players.push(player);
      this.autoAssignTeam(player);
    }
    return { ok: true, player, reconnected: false };
  }

  private autoAssignTeam(player: Player): void {
    // assign to the currently smaller team (counting everyone on a team)
    const onTeam = (t: TeamId) => this.room.players.filter((p) => p.teamId === t).length;
    player.teamId = onTeam('A') <= onTeam('B') ? 'A' : 'B';
  }

  // -------------------------------------------------------------- lobby ops
  assignTeam(hostId: string, playerId: string, teamId: TeamId): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can assign teams.');
    if (this.room.phase !== 'LOBBY') return err('Teams lock once the game starts.');
    const p = this.player(playerId);
    if (!p) return err('No such player.');
    p.teamId = teamId;
    return ok;
  }

  updateSettings(hostId: string, patch: Partial<RoomSettings>): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can change settings.');
    if (this.room.phase !== 'LOBBY') return err('Settings lock once the game starts.');
    Object.assign(this.room.settings, patch);
    this.room.timer.enabled = this.room.settings.timersEnabled;
    return ok;
  }

  setCastConnected(connected: boolean): EngineResult {
    const was = this.room.castConnected;
    this.room.castConnected = connected;
    if (!connected && was && IN_PROGRESS_PHASES.includes(this.room.phase)) {
      this.pause('CAST_DROPPED', this.host()?.id ?? null);
    } else if (connected) {
      this.maybeResume();
    }
    return ok;
  }

  // ------------------------------------------------------------------ start
  start(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can start the game.');
    if (this.room.phase !== 'LOBBY') return err('Game already started.');
    if (!this.room.castConnected) return err('Connect to the TV (cast) before starting.');

    const present = this.room.players.filter((p) => p.connected);
    if (present.length < MIN_PLAYERS) return err(`Need at least ${MIN_PLAYERS} players.`);
    if (present.length > MAX_PLAYERS) return err(`At most ${MAX_PLAYERS} players.`);

    if (present.length === THREE_PLAYER_COUNT) {
      this.room.mode = 'THREE_PLAYER';
      for (const p of present) p.teamId = null;
      this.threeSeating = present.slice().sort((a, b) => a.joinOrder - b.joinOrder).map((p) => p.id);
      this.threeInsiderIndex = -1;
    } else {
      this.room.mode = 'TEAM';
      const a = this.room.players.filter((p) => p.teamId === 'A').length;
      const b = this.room.players.filter((p) => p.teamId === 'B').length;
      if (a < 2 || b < 2) return err('Each team needs at least 2 players.');
    }

    // fresh token state
    for (const p of this.room.players) {
      p.tokensFlipped = 0;
      p.hasBeenInsiderThisGame = false;
      p.pendingJoin = false;
    }
    this.team('A').tokensFlipped = 0;
    this.team('B').tokensFlipped = 0;
    this.room.winnerTeamId = null;
    this.room.winnerPlayerIds = [];
    this.room.servedMessages.clear();

    this.beginRound(1);
    return ok;
  }

  // ------------------------------------------------------------- round flow
  private beginRound(roundNumber: number): void {
    // Activate mid-game TEAM joiners (3-Player joiners stay queued until end).
    if (this.room.mode === 'TEAM') {
      for (const p of this.room.players) p.pendingJoin = false;
    }

    const insiders: InsiderRoundState[] = [];
    if (this.room.mode === 'TEAM') {
      for (const teamId of ['A', 'B'] as TeamId[]) {
        const insiderId = this.chooseTeamInsider(teamId);
        insiders.push(this.makeInsiderState(insiderId));
      }
    } else {
      const insiderId = this.chooseThreeInsider();
      insiders.push(this.makeInsiderState(insiderId));
    }

    this.room.round = {
      roundNumber,
      insiders,
      firstInsiderPlayerId: null,
      activeGuessing: null,
    };
    this.room.phase = 'WRITE_CLUES';
    this.startTimer(CLUE_WRITE_SECONDS);
  }

  private makeInsiderState(insiderId: string): InsiderRoundState {
    const card = this.cardSource.deal(this.room.settings.difficulty, this.room.servedMessages);
    if (!card) throw new Error('Card source exhausted.');
    // In-session dedupe: every option dealt is now "served".
    for (const opt of card.options) this.room.servedMessages.add(normalizeText(opt.text));
    const insider = this.player(insiderId);
    if (insider) insider.hasBeenInsiderThisGame = true;
    return {
      insiderPlayerId: insiderId,
      card,
      chosenOptionIndex: null,
      clueBoards: BOARD_SLOTS.map((slot) => ({ slot, clue: '', faceUp: false })),
      submitted: false,
      submittedAt: null,
    };
  }

  private chooseTeamInsider(teamId: TeamId): string {
    let pool = this.teamPlayers(teamId);
    if (pool.length === 0) throw new Error(`Team ${teamId} has no players.`);
    let eligible = pool.filter((p) => !p.hasBeenInsiderThisGame);
    if (eligible.length === 0) {
      for (const p of pool) p.hasBeenInsiderThisGame = false;
      eligible = pool;
    }
    const chosen =
      this.room.settings.rotationMode === 'RANDOM' ? this.rng.pick(eligible) : eligible[0]!;
    return chosen.id;
  }

  private chooseThreeInsider(): string {
    if (this.threeInsiderIndex < 0) {
      this.threeInsiderIndex =
        this.room.settings.rotationMode === 'RANDOM' ? this.rng.int(THREE_PLAYER_COUNT) : 0;
    } else {
      // Insider rotates to the previous Interceptor (player to old insider's left).
      this.threeInsiderIndex = (this.threeInsiderIndex - 1 + THREE_PLAYER_COUNT) % THREE_PLAYER_COUNT;
    }
    return this.threeSeating[this.threeInsiderIndex]!;
  }

  private threeRoles(): { insiderId: string; interceptorId: string; contactId: string } {
    const i = this.threeInsiderIndex;
    return {
      insiderId: this.threeSeating[i]!,
      interceptorId: this.threeSeating[(i - 1 + THREE_PLAYER_COUNT) % THREE_PLAYER_COUNT]!,
      contactId: this.threeSeating[(i + 1) % THREE_PLAYER_COUNT]!,
    };
  }

  // --------------------------------------------------------- write clues
  private currentInsiderState(playerId: string): InsiderRoundState | undefined {
    return this.room.round?.insiders.find((i) => i.insiderPlayerId === playerId);
  }

  chooseOption(playerId: string, optionIndex: number): EngineResult {
    if (this.room.phase !== 'WRITE_CLUES') return err('Not in clue-writing phase.');
    const ins = this.currentInsiderState(playerId);
    if (!ins) return err('You are not an Insider this round.');
    if (ins.submitted) return err('Clues already submitted.');
    if (optionIndex < 0 || optionIndex >= ins.card.options.length) return err('Invalid option.');
    ins.chosenOptionIndex = optionIndex;
    return ok;
  }

  setClue(playerId: string, slot: BoardSlot, clue: string): EngineResult {
    if (this.room.phase !== 'WRITE_CLUES') return err('Not in clue-writing phase.');
    const ins = this.currentInsiderState(playerId);
    if (!ins) return err('You are not an Insider this round.');
    if (ins.submitted) return err('Clues already submitted.');
    const board = ins.clueBoards.find((b) => b.slot === slot);
    if (!board) return err('Invalid clue board.');
    board.clue = clue.trim();
    return ok;
  }

  submitClues(playerId: string): EngineResult {
    if (this.room.phase !== 'WRITE_CLUES') return err('Not in clue-writing phase.');
    const ins = this.currentInsiderState(playerId);
    if (!ins) return err('You are not an Insider this round.');
    if (ins.submitted) return err('Already submitted.');
    if (ins.chosenOptionIndex === null) return err('Pick a message first.');
    ins.submitted = true;
    ins.submittedAt = this.now();
    this.maybeStartGuessing();
    return ok;
  }

  /** Clue-writing timer expired: auto-submit everyone not yet submitted (§4.10). */
  clueTimerExpired(): EngineResult {
    if (this.room.phase !== 'WRITE_CLUES' || !this.room.round) return err('No active clue timer.');
    for (const ins of this.room.round.insiders) {
      if (!ins.submitted) {
        if (ins.chosenOptionIndex === null) ins.chosenOptionIndex = 0; // default message
        ins.submitted = true;
        ins.submittedAt = this.now();
      }
    }
    this.maybeStartGuessing();
    return ok;
  }

  private maybeStartGuessing(): void {
    const round = this.room.round!;
    if (!round.insiders.every((i) => i.submitted)) return;

    // First Insider = earliest submittedAt, tie-broken by joinOrder.
    const sorted = round.insiders.slice().sort((a, b) => {
      const ta = a.submittedAt ?? Infinity;
      const tb = b.submittedAt ?? Infinity;
      if (ta !== tb) return ta - tb;
      const ja = this.player(a.insiderPlayerId)?.joinOrder ?? 0;
      const jb = this.player(b.insiderPlayerId)?.joinOrder ?? 0;
      return ja - jb;
    });
    round.firstInsiderPlayerId = sorted[0]!.insiderPlayerId;
    this.setupGuessing(sorted[0]!.insiderPlayerId, 'GUESS_FIRST');
  }

  private setupGuessing(insiderId: string, phase: 'GUESS_FIRST' | 'GUESS_SECOND'): void {
    const ins = this.currentInsiderState(insiderId)!;
    // reset boards facedown for this message
    for (const b of ins.clueBoards) b.faceUp = false;

    let steps: GuessStep[];
    let contactTeam: TeamId | null = null;
    let interceptTeam: TeamId | null = null;

    if (this.room.mode === 'TEAM') {
      const insider = this.player(insiderId)!;
      contactTeam = insider.teamId!;
      interceptTeam = this.otherTeam(contactTeam);
      steps = [
        { guessingTeam: interceptTeam, guessingRole: null, flippedSlot: null, spokenResult: null },
        { guessingTeam: interceptTeam, guessingRole: null, flippedSlot: null, spokenResult: null },
        { guessingTeam: contactTeam, guessingRole: null, flippedSlot: null, spokenResult: null },
      ];
    } else {
      steps = [
        { guessingTeam: null, guessingRole: 'INTERCEPTOR', flippedSlot: null, spokenResult: null },
        { guessingTeam: null, guessingRole: 'INTERCEPTOR', flippedSlot: null, spokenResult: null },
        { guessingTeam: null, guessingRole: 'CONTACT', flippedSlot: null, spokenResult: null },
      ];
    }

    const revealedCategory: Category | null = this.room.settings.casualMode
      ? ins.card.options[ins.chosenOptionIndex!]!.category
      : null;

    this.room.round!.activeGuessing = {
      insiderPlayerId: insiderId,
      contactTeam,
      interceptTeam,
      steps,
      currentStepIndex: 0,
      resolved: false,
      resolution: null,
      revealedCategory,
    };
    this.room.phase = phase;
    this.startTimer(GUESS_SECONDS);
  }

  // ------------------------------------------------------------- guessing
  flip(playerId: string, slot: BoardSlot): EngineResult {
    if (this.room.phase !== 'GUESS_FIRST' && this.room.phase !== 'GUESS_SECOND') {
      return err('Not a guessing phase.');
    }
    const g = this.room.round?.activeGuessing;
    if (!g || g.resolved) return err('No active message.');
    if (g.insiderPlayerId !== playerId) return err('Only the active Insider flips boards.');
    const step = g.steps[g.currentStepIndex]!;
    if (step.flippedSlot) return err('A board is already flipped this step.');
    const ins = this.currentInsiderState(g.insiderPlayerId)!;
    const board = ins.clueBoards.find((b) => b.slot === slot);
    if (!board) return err('Invalid board.');
    if (board.faceUp) return err('That board is already face-up.');
    board.faceUp = true;
    step.flippedSlot = slot;
    return ok;
  }

  recordResult(playerId: string, result: GuessResult): EngineResult {
    if (this.room.phase !== 'GUESS_FIRST' && this.room.phase !== 'GUESS_SECOND') {
      return err('Not a guessing phase.');
    }
    const g = this.room.round?.activeGuessing;
    if (!g || g.resolved) return err('No active message.');
    if (g.insiderPlayerId !== playerId) return err('Only the active Insider records results.');
    const step = g.steps[g.currentStepIndex]!;
    if (!step.flippedSlot) return err('Flip the requested board first.');
    if (step.spokenResult) return err('Result already recorded for this guess.');
    step.spokenResult = result;

    const isInterceptStep = g.currentStepIndex < 2;
    if (result === 'CORRECT') {
      if (isInterceptStep) {
        this.scoreIntercept(g);
      } else {
        this.scoreContact(g);
      }
      this.resolveMessage('GUESSED');
    } else if (g.currentStepIndex < 2) {
      this.advanceStep(g);
    } else {
      // all three wrong -> message lost, intercept side scores
      this.scoreIntercept(g);
      this.resolveMessage('LOST');
    }
    return ok;
  }

  private advanceStep(g: NonNullable<NonNullable<GameRoom['round']>['activeGuessing']>): void {
    g.currentStepIndex += 1;
    if (g.currentStepIndex === 2) {
      // Contact Final: the last facedown board auto-reveals (§4.3).
      const ins = this.currentInsiderState(g.insiderPlayerId)!;
      const last = ins.clueBoards.find((b) => !b.faceUp);
      if (last) {
        last.faceUp = true;
        g.steps[2]!.flippedSlot = last.slot;
      }
    }
    this.startTimer(GUESS_SECONDS);
  }

  private scoreIntercept(g: NonNullable<NonNullable<GameRoom['round']>['activeGuessing']>): void {
    if (this.room.mode === 'TEAM') {
      this.flipTeamToken(g.interceptTeam!);
    } else {
      this.flipPlayerToken(this.threeRoles().interceptorId);
    }
    this.checkWin();
  }

  private scoreContact(g: NonNullable<NonNullable<GameRoom['round']>['activeGuessing']>): void {
    if (this.room.mode === 'TEAM') {
      this.flipTeamToken(g.contactTeam!);
    } else {
      const { contactId, insiderId } = this.threeRoles();
      this.flipPlayerToken(contactId);
      this.flipPlayerToken(insiderId); // Contact correct → both Contact and Insider score
    }
    this.checkWin();
  }

  private flipTeamToken(teamId: TeamId): void {
    const t = this.team(teamId);
    t.tokensFlipped = Math.min(TOKENS_TO_WIN, t.tokensFlipped + 1);
    // mirror onto each team member for uniform display
    for (const p of this.room.players.filter((pl) => pl.teamId === teamId)) {
      p.tokensFlipped = t.tokensFlipped;
    }
  }

  private flipPlayerToken(playerId: string): void {
    const p = this.player(playerId);
    if (p) p.tokensFlipped = Math.min(TOKENS_TO_WIN, p.tokensFlipped + 1);
  }

  private checkWin(): void {
    if (this.room.mode === 'TEAM') {
      const winner = this.room.teams.find((t) => t.tokensFlipped >= TOKENS_TO_WIN);
      if (winner) {
        this.room.winnerTeamId = winner.id;
        this.endGame();
      }
    } else {
      const winners = this.room.players.filter((p) => p.tokensFlipped >= TOKENS_TO_WIN);
      if (winners.length > 0) {
        this.room.winnerPlayerIds = winners.map((p) => p.id);
        this.endGame();
      }
    }
  }

  private resolveMessage(resolution: 'GUESSED' | 'LOST'): void {
    if (this.room.phase === 'GAME_OVER') return; // a win already ended things mid-resolution
    const g = this.room.round!.activeGuessing!;
    g.resolved = true;
    g.resolution = resolution;

    if (this.room.mode === 'TEAM' && this.room.phase === 'GUESS_FIRST') {
      // proceed to the 2nd Insider's message
      const round = this.room.round!;
      const second = round.insiders.find((i) => i.insiderPlayerId !== g.insiderPlayerId)!;
      this.setupGuessing(second.insiderPlayerId, 'GUESS_SECOND');
    } else {
      this.room.phase = 'ROUND_END';
      this.stopTimer();
    }
  }

  // ----------------------------------------------------------- round end
  nextRound(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can advance the round.');
    if (this.room.phase !== 'ROUND_END') return err('Round is not over.');
    this.beginRound((this.room.round?.roundNumber ?? 0) + 1);
    return ok;
  }

  private endGame(): void {
    this.room.phase = 'GAME_OVER';
    this.stopTimer();
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
    this.room.phaseBeforePause = null;
  }

  // ----------------------------------------------------------- host powers
  forceEnd(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can end the game.');
    this.endGame();
    return ok;
  }

  rematch(hostId: string): EngineResult {
    if (!this.isHost(hostId)) return err('Only the host can start a rematch.');
    // back to a fresh lobby with reshuffled teams, same room/code (§4.1.1 #11)
    this.room.phase = 'LOBBY';
    this.room.round = null;
    this.room.mode = 'TEAM';
    this.room.winnerTeamId = null;
    this.room.winnerPlayerIds = [];
    this.room.servedMessages.clear();
    this.team('A').tokensFlipped = 0;
    this.team('B').tokensFlipped = 0;
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
    this.room.phaseBeforePause = null;
    this.stopTimer();
    // reshuffle present players across teams
    const present = this.room.players
      .filter((p) => p.connected)
      .sort((a, b) => a.joinOrder - b.joinOrder);
    this.rng.shuffle(present);
    present.forEach((p, i) => {
      p.teamId = i % 2 === 0 ? 'A' : 'B';
      p.tokensFlipped = 0;
      p.hasBeenInsiderThisGame = false;
      p.pendingJoin = false;
    });
    return ok;
  }

  flagCard(playerId: string): { ok: boolean; option?: { category: Category; text: string } } {
    // Logged as a feedback signal (§4.12). Return the flagged option for logging.
    const g = this.room.round?.activeGuessing;
    if (!g) return { ok: false };
    const ins = this.currentInsiderState(g.insiderPlayerId);
    if (!ins || ins.chosenOptionIndex === null) return { ok: false };
    return { ok: true, option: ins.card.options[ins.chosenOptionIndex] };
  }

  // ------------------------------------------------------ disconnect/pause
  disconnect(playerId: string): EngineResult {
    const p = this.player(playerId);
    if (!p) return err('No such player.');
    p.connected = false;

    if (p.isHost) this.transferHost(p);

    if (IN_PROGRESS_PHASES.includes(this.room.phase)) {
      this.pause('PLAYER_DISCONNECT', playerId);
    }
    return ok;
  }

  /** Permanently remove a player (lobby leave / host kick). */
  removePlayer(playerId: string): EngineResult {
    const p = this.player(playerId);
    if (!p) return err('No such player.');
    if (p.isHost) this.transferHost(p);
    this.room.players = this.room.players.filter((x) => x.id !== playerId);
    if (this.room.phase === 'PAUSED') this.maybeResume();
    return ok;
  }

  private transferHost(old: Player): void {
    old.isHost = false;
    const candidates = this.room.players.filter((p) => p.id !== old.id && p.connected);
    if (candidates.length === 0) {
      old.isHost = true; // nobody to take over; keep (game stays paused)
      return;
    }
    // prefer a Chrome device that can re-establish the cast session
    const caster = candidates.find((p) => p.canHostCast);
    (caster ?? candidates[0]!).isHost = true;
  }

  private pause(reason: 'PLAYER_DISCONNECT' | 'CAST_DROPPED', waitingForPlayerId: string | null): void {
    if (this.room.phase === 'PAUSED') {
      // keep the earliest blocking reason but update who we're waiting on
      if (!this.room.pause.waitingForPlayerId && waitingForPlayerId) {
        this.room.pause.waitingForPlayerId = waitingForPlayerId;
      }
      return;
    }
    this.pausedRemainingMs = this.room.timer.phaseDeadline
      ? Math.max(0, this.room.timer.phaseDeadline - this.now())
      : null;
    this.room.phaseBeforePause = this.room.phase;
    this.room.phase = 'PAUSED';
    this.room.timer.phaseDeadline = null;
    this.room.pause = { active: true, reason, waitingForPlayerId };
  }

  private maybeResume(): void {
    if (this.room.phase !== 'PAUSED') return;
    const anyDisconnectedActive = this.room.players.some((p) => !p.connected && !p.pendingJoin);
    if (anyDisconnectedActive) return;
    if (!this.room.castConnected) return;

    this.room.phase = this.room.phaseBeforePause ?? 'LOBBY';
    this.room.phaseBeforePause = null;
    this.room.pause = { active: false, reason: null, waitingForPlayerId: null };
    if (this.room.timer.enabled && this.pausedRemainingMs !== null) {
      this.room.timer.phaseDeadline = this.now() + this.pausedRemainingMs;
    }
    this.pausedRemainingMs = null;
  }

  // ----------------------------------------------------------------- timer
  private startTimer(seconds: number): void {
    if (this.room.timer.enabled) {
      this.room.timer.phaseDeadline = this.now() + seconds * 1000;
    } else {
      this.room.timer.phaseDeadline = null;
    }
  }
  private stopTimer(): void {
    this.room.timer.phaseDeadline = null;
  }

  // ------------------------------------------------------- introspection
  getThreeRole(playerId: string): ThreePlayerRole | null {
    if (this.room.mode !== 'THREE_PLAYER' || !this.room.round) return null;
    const roles = this.threeRoles();
    if (playerId === roles.insiderId) return 'INSIDER';
    if (playerId === roles.interceptorId) return 'INTERCEPTOR';
    if (playerId === roles.contactId) return 'CONTACT';
    return null;
  }

  isInsiderNow(playerId: string): boolean {
    return !!this.currentInsiderState(playerId);
  }
}
