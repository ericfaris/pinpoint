// ============================================================================
// Triangulation — Canonical server-side game-state data model (PRD §9.5).
// This is the single source of truth. Clients render projections of it with
// hidden fields stripped (see projection.ts / spectator-safe rule §5).
// ============================================================================

// ---------- Enums / unions ----------
/** Character, Media, Person, Location, Brand, Wildcard */
export type Category = 'C' | 'M' | 'P' | 'L' | 'B' | 'W';
export const CATEGORIES: Category[] = ['C', 'M', 'P', 'L', 'B', 'W'];
export const CATEGORY_LABELS: Record<Category, string> = {
  C: 'Character',
  M: 'Media',
  P: 'Person',
  L: 'Location',
  B: 'Brand',
  W: 'Wildcard',
};

export type GameMode = 'TEAM' | 'THREE_PLAYER';
export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type RotationMode = 'IN_ORDER' | 'RANDOM';
export type TeamId = 'A' | 'B';
/** the 3 clue boards */
export type BoardSlot = 'A' | 'B' | 'C';
export const BOARD_SLOTS: BoardSlot[] = ['A', 'B', 'C'];
export type GuessResult = 'CORRECT' | 'INCORRECT';

export type RoomPhase =
  | 'LOBBY' // pre-game, players joining/configuring
  | 'WRITE_CLUES' // Phase 1
  | 'GUESS_FIRST' // Phase 2
  | 'GUESS_SECOND' // Phase 3
  | 'ROUND_END' // brief interstitial before next round
  | 'GAME_OVER'
  | 'PAUSED'; // disconnect/cast-drop; see `pause`

/** In 3-Player Mode the two guessing positions are named roles. */
export type ThreePlayerRole = 'INSIDER' | 'INTERCEPTOR' | 'CONTACT';

// ---------- Cards ----------
export interface MessageOption {
  category: Category;
  text: string; // the proper-name message
}
export interface MessageCard {
  id: string;
  options: MessageOption[]; // exactly 6, one per category
}

// ---------- Players & Teams ----------
export interface Player {
  id: string; // stable server-assigned id
  reconnectToken: string; // secret; how a returning player reclaims this seat (§4.8)
  displayName: string; // unique within the room (case-insensitive)
  teamId: TeamId | null; // null in 3-Player Mode
  connected: boolean;
  isHost: boolean; // exactly one player is host at a time; transferable
  canHostCast: boolean; // true if this device reported Cast Sender support (Chrome)
  hasBeenInsiderThisGame: boolean; // supports IN_ORDER rotation
  pendingJoin: boolean; // joined mid-game / queued (§4.1.3); not yet active
  tokensFlipped: number; // 0-4; per-player in 3-Player Mode, else mirror of team count
  joinOrder: number; // monotonically increasing; drives IN_ORDER rotation & seating
}
export interface Team {
  id: TeamId;
  tokensFlipped: number; // 0-4
}

// ---------- Per-Insider round state ----------
export interface ClueBoard {
  slot: BoardSlot;
  clue: string; // one word; '' if blank/auto-submitted
  faceUp: boolean; // revealed during guessing
}
export interface InsiderRoundState {
  insiderPlayerId: string;
  card: MessageCard; // SERVER-ONLY for the 6 options; never broadcast to others
  chosenOptionIndex: number | null; // which of the 6 the Insider picked
  clueBoards: ClueBoard[]; // exactly 3
  submitted: boolean; // clues locked in
  submittedAt: number | null; // ms epoch; earliest submit => 1st Insider
}

// ---------- Guessing state (one active message at a time) ----------
export interface GuessStep {
  /** (TEAM mode) which team is guessing this step */
  guessingTeam: TeamId | null;
  /** (3P mode) which named role is guessing this step */
  guessingRole: ThreePlayerRole | null;
  flippedSlot: BoardSlot | null; // which board this step revealed
  spokenResult: GuessResult | null; // Insider's tap; verbal guess itself is never stored
}
export interface ActiveMessageGuessing {
  insiderPlayerId: string; // whose message is being guessed
  contactTeam: TeamId | null; // teammates of the insider (TEAM mode)
  interceptTeam: TeamId | null; // opponents (TEAM mode)
  steps: GuessStep[]; // ordered: Intercept1, Intercept2, ContactFinal
  currentStepIndex: number; // 0..2
  resolved: boolean;
  resolution: 'GUESSED' | 'LOST' | null;
  /** category revealed for Casual Mode, else null */
  revealedCategory: Category | null;
}

// ---------- Timers ----------
export interface TimerState {
  enabled: boolean;
  phaseDeadline: number | null; // ms epoch the current countdown ends; null if no active timer
}

// ---------- Settings (host-configured in lobby) ----------
export interface RoomSettings {
  casualMode: boolean; // reveal chosen option's category before guessing
  timersEnabled: boolean;
  rotationMode: RotationMode;
  difficulty: Difficulty;
}

// ---------- Pause ----------
export interface PauseState {
  active: boolean;
  reason: 'PLAYER_DISCONNECT' | 'CAST_DROPPED' | null;
  waitingForPlayerId: string | null;
}

// ---------- Round ----------
export interface RoundState {
  roundNumber: number;
  insiders: InsiderRoundState[]; // 2 in TEAM mode, 1 in 3-Player
  firstInsiderPlayerId: string | null; // earliest submittedAt
  activeGuessing: ActiveMessageGuessing | null; // current message being guessed
}

// ---------- Top-level room ----------
export interface GameRoom {
  code: string; // 4-digit join code
  mode: GameMode;
  phase: RoomPhase;
  settings: RoomSettings;
  players: Player[];
  teams: Team[]; // empty in 3-Player Mode
  round: RoundState | null; // null while in LOBBY
  servedMessages: Set<string>; // in-session dedupe (normalized message text)
  timer: TimerState;
  pause: PauseState;
  winnerTeamId: TeamId | null; // TEAM mode result
  winnerPlayerIds: string[]; // 3-Player result (supports shared win)
  castConnected: boolean; // must be true to leave LOBBY / continue play
  createdAt: number;
  /** phase to return to when un-pausing */
  phaseBeforePause: RoomPhase | null;
}

// ---------- Constants ----------
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const THREE_PLAYER_COUNT = 3;
export const TOKENS_TO_WIN = 4;
export const CLUE_WRITE_SECONDS = 90;
export const GUESS_SECONDS = 45;
