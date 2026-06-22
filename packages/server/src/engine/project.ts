// Spectator-safe projectors (PRD §5). Build the broadcast PublicRoom and the
// per-socket PrivateState from the authoritative GameRoom, stripping any
// hidden info (other Insiders' options, unflipped clue words).
import type {
  ClueBoard,
  GameRoom,
  InsiderRoundState,
  PublicActiveGuessing,
  PublicClueBoard,
  PublicInsiderState,
  PublicRoom,
  PublicRound,
  PrivateState,
} from '@pinpoint/shared';
import type { GameEngine } from './engine.js';

function projectClueBoard(b: ClueBoard): PublicClueBoard {
  return { slot: b.slot, faceUp: b.faceUp, clue: b.faceUp ? b.clue : null };
}

function projectInsider(ins: InsiderRoundState): PublicInsiderState {
  return {
    insiderPlayerId: ins.insiderPlayerId,
    submitted: ins.submitted,
    submittedAt: ins.submittedAt,
    clueBoards: ins.clueBoards.map(projectClueBoard),
  };
}

export function toPublicRoom(room: GameRoom, now: number): PublicRoom {
  let round: PublicRound | null = null;
  if (room.round) {
    let activeGuessing: PublicActiveGuessing | null = null;
    if (room.round.activeGuessing) {
      const g = room.round.activeGuessing;
      activeGuessing = {
        insiderPlayerId: g.insiderPlayerId,
        contactTeam: g.contactTeam,
        interceptTeam: g.interceptTeam,
        steps: g.steps.map((s) => ({
          guessingTeam: s.guessingTeam,
          guessingRole: s.guessingRole,
          flippedSlot: s.flippedSlot,
          spokenResult: s.spokenResult,
        })),
        currentStepIndex: g.currentStepIndex,
        resolved: g.resolved,
        resolution: g.resolution,
        revealedCategory: g.revealedCategory,
      };
    }
    round = {
      roundNumber: room.round.roundNumber,
      insiders: room.round.insiders.map(projectInsider),
      firstInsiderPlayerId: room.round.firstInsiderPlayerId,
      activeGuessing,
    };
  }

  return {
    code: room.code,
    mode: room.mode,
    phase: room.phase,
    settings: { ...room.settings },
    players: room.players.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      teamId: p.teamId,
      connected: p.connected,
      isHost: p.isHost,
      canHostCast: p.canHostCast,
      pendingJoin: p.pendingJoin,
      tokensFlipped: p.tokensFlipped,
      joinOrder: p.joinOrder,
      hasBeenInsiderThisGame: p.hasBeenInsiderThisGame,
    })),
    teams: room.teams.map((t) => ({ id: t.id, tokensFlipped: t.tokensFlipped })),
    round,
    timer: { ...room.timer },
    pause: { ...room.pause },
    winnerTeamId: room.winnerTeamId,
    winnerPlayerIds: [...room.winnerPlayerIds],
    castConnected: room.castConnected,
    serverNow: now,
  };
}

export function toPrivateState(engine: GameEngine, playerId: string | null): PrivateState {
  const room = engine.room;
  if (!playerId) {
    return {
      playerId: null,
      reconnectToken: null,
      isHost: false,
      teamId: null,
      threePlayerRole: null,
      isInsider: false,
      card: null,
      chosenOptionIndex: null,
      ownClues: null,
    };
  }
  const p = room.players.find((pl) => pl.id === playerId);
  const ins = room.round?.insiders.find((i) => i.insiderPlayerId === playerId);
  const isInsider = !!ins;
  return {
    playerId,
    reconnectToken: p?.reconnectToken ?? null,
    isHost: p?.isHost ?? false,
    teamId: p?.teamId ?? null,
    threePlayerRole: engine.getThreeRole(playerId),
    isInsider,
    // Only the Insider receives their own card options + chosen index + clues.
    card: ins ? ins.card.options : null,
    chosenOptionIndex: ins ? ins.chosenOptionIndex : null,
    ownClues: ins ? ins.clueBoards.map((b) => ({ slot: b.slot, clue: b.clue })) : null,
  };
}
