// ============================================================================
// Spectator-safe projections (PRD §5). The server NEVER broadcasts hidden
// info (other Insiders' card options, unflipped clue words) to clients that
// must not see it. Two surfaces:
//   - PublicRoom: broadcast to everyone + the TV receiver.
//   - PrivateState: sent only to the owning socket (your card, your clues).
// ============================================================================
import type {
  BoardSlot,
  Category,
  GameMode,
  GuessResult,
  MessageOption,
  PauseState,
  RoomPhase,
  RoomSettings,
  TeamId,
  ThreePlayerRole,
  TimerState,
} from './types.js';

// ---------- Public (everyone, incl. TV) ----------
export interface PublicPlayer {
  id: string;
  displayName: string;
  teamId: TeamId | null;
  connected: boolean;
  isHost: boolean;
  canHostCast: boolean;
  pendingJoin: boolean;
  tokensFlipped: number;
  joinOrder: number;
  /** true once they've been Insider this game (no leakage, just UI). */
  hasBeenInsiderThisGame: boolean;
}

/** A clue board as seen publicly: the word is present ONLY when faceUp. */
export interface PublicClueBoard {
  slot: BoardSlot;
  faceUp: boolean;
  clue: string | null; // null while facedown (never leak the word)
}

/** Public view of an Insider's round state — no card, no chosen option. */
export interface PublicInsiderState {
  insiderPlayerId: string;
  submitted: boolean;
  submittedAt: number | null;
  clueBoards: PublicClueBoard[];
}

export interface PublicGuessStep {
  guessingTeam: TeamId | null;
  guessingRole: ThreePlayerRole | null;
  flippedSlot: BoardSlot | null;
  spokenResult: GuessResult | null;
}

export interface PublicActiveGuessing {
  insiderPlayerId: string;
  contactTeam: TeamId | null;
  interceptTeam: TeamId | null;
  steps: PublicGuessStep[];
  currentStepIndex: number;
  resolved: boolean;
  resolution: 'GUESSED' | 'LOST' | null;
  revealedCategory: Category | null; // Casual Mode only
}

export interface PublicRound {
  roundNumber: number;
  insiders: PublicInsiderState[];
  firstInsiderPlayerId: string | null;
  activeGuessing: PublicActiveGuessing | null;
}

export interface PublicRoom {
  code: string;
  mode: GameMode;
  phase: RoomPhase;
  settings: RoomSettings;
  players: PublicPlayer[];
  teams: { id: TeamId; tokensFlipped: number }[];
  round: PublicRound | null;
  timer: TimerState;
  pause: PauseState;
  winnerTeamId: TeamId | null;
  winnerPlayerIds: string[];
  castConnected: boolean;
  /** server time when projected, so clients can reconcile timer deadlines. */
  serverNow: number;
}

// ---------- Private (only the owning socket) ----------
export interface PrivateState {
  playerId: string | null;
  reconnectToken: string | null;
  isHost: boolean;
  teamId: TeamId | null;
  threePlayerRole: ThreePlayerRole | null;
  /** Whether this socket is the active Insider this round. */
  isInsider: boolean;
  /** The 6 options — only present if this socket is the Insider. */
  card: MessageOption[] | null;
  chosenOptionIndex: number | null;
  /** This Insider's own clue words (visible to them pre-flip). */
  ownClues: { slot: BoardSlot; clue: string }[] | null;
}
