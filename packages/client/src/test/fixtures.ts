import type {
  BoardSlot,
  PrivateState,
  PublicPlayer,
  PublicRoom,
  ThreePlayerRole,
} from '@pinpoint/shared';

export function makePlayer(overrides: Partial<PublicPlayer> & { id: string }): PublicPlayer {
  return {
    displayName: overrides.id,
    teamId: null,
    connected: true,
    isHost: false,
    canHostCast: false,
    pendingJoin: false,
    tokensFlipped: 0,
    joinOrder: 0,
    hasBeenInsiderThisGame: false,
    ...overrides,
  };
}

function clueBoards(faceUp = false): { slot: BoardSlot; faceUp: boolean; clue: string | null }[] {
  return (['A', 'B', 'C'] as BoardSlot[]).map((slot) => ({ slot, faceUp, clue: faceUp ? 'word' : null }));
}

/** Minimal but structurally valid PublicRoom, defaulted to a 3-player WRITE_CLUES round. */
export function makePub(overrides: Partial<PublicRoom> = {}): PublicRoom {
  const players =
    overrides.players ??
    [
      makePlayer({ id: 'p1', displayName: 'Eric', isHost: true }),
      makePlayer({ id: 'p2', displayName: 'Lincoln' }),
      makePlayer({ id: 'p3', displayName: 'April' }),
    ];
  return {
    code: '1234',
    mode: 'THREE_PLAYER',
    phase: 'WRITE_CLUES',
    settings: { casualMode: false, timersEnabled: false, rotationMode: 'IN_ORDER', difficulty: 'MEDIUM' },
    players,
    teams: [
      { id: 'A', tokensFlipped: 0 },
      { id: 'B', tokensFlipped: 0 },
    ],
    round: {
      roundNumber: 1,
      insiders: [
        { insiderPlayerId: players[0]!.id, submitted: false, submittedAt: null, clueBoards: clueBoards() },
      ],
      firstInsiderPlayerId: null,
      activeGuessing: null,
    },
    timer: { enabled: false, phaseDeadline: null },
    pause: { active: false, reason: null, waitingForPlayerId: null },
    winnerTeamId: null,
    winnerPlayerIds: [],
    castConnected: true,
    serverNow: Date.now(),
    ...overrides,
  };
}

/** Minimal but structurally valid PrivateState for a non-Insider player. */
export function makePriv(overrides: Partial<PrivateState> = {}): PrivateState {
  return {
    playerId: 'p2',
    reconnectToken: 'tok',
    isHost: false,
    teamId: null,
    threePlayerRole: null,
    isInsider: false,
    card: null,
    chosenOptionIndex: null,
    ownClues: null,
    ...overrides,
  };
}

export function threePlayerFixture(myRole: ThreePlayerRole) {
  const roleToPlayer: Record<ThreePlayerRole, string> = {
    INSIDER: 'p1',
    INTERCEPTOR: 'p2',
    CONTACT: 'p3',
  };
  const myId = roleToPlayer[myRole];
  const pub = makePub({
    mode: 'THREE_PLAYER',
    round: {
      roundNumber: 1,
      insiders: [{ insiderPlayerId: 'p1', submitted: false, submittedAt: null, clueBoards: clueBoards() }],
      firstInsiderPlayerId: null,
      activeGuessing: null,
    },
  });
  const priv = makePriv({ playerId: myId, threePlayerRole: myRole, isInsider: myRole === 'INSIDER' });
  return { pub, priv };
}
