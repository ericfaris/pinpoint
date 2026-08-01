// Regression coverage for two 3-Player Mode UI bugs found during playtesting:
//   1. Non-Insiders saw "Insiders are writing clues…" (plural) even though
//      3-Player Mode has exactly one Insider.
//   2. Nothing on screen told a player which role (Insider/Interceptor/
//      Contact) they were playing this round.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// screens.tsx imports the socket-backed `store` singleton, which opens a
// real socket.io connection on module load. Stub it out so tests don't hit
// the network.
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

const { WriteClues, Guessing } = await import('../screens.js');
const { makePub, makePriv, threePlayerFixture } = await import('../../test/fixtures.js');

describe('WriteClues — Insider count wording', () => {
  it('3-Player Mode: non-Insider sees singular "Insider is writing clues…"', () => {
    const { pub, priv } = threePlayerFixture('INTERCEPTOR');
    render(<WriteClues pub={pub} priv={priv} />);
    expect(screen.getByText('Insider is writing clues…')).toBeInTheDocument();
    expect(screen.queryByText('Insiders are writing clues…')).not.toBeInTheDocument();
  });

  it('TEAM Mode: non-Insider sees plural "Insiders are writing clues…"', () => {
    // 4-player TEAM fixture: 2 insiders, one per team.
    const teamPub = makePub({
      mode: 'TEAM',
      players: [
        { id: 'p1', displayName: 'Eric', teamId: 'A', connected: true, isHost: true, canHostCast: true, pendingJoin: false, tokensFlipped: 0, joinOrder: 0, hasBeenInsiderThisGame: true },
        { id: 'p2', displayName: 'Lincoln', teamId: 'A', connected: true, isHost: false, canHostCast: false, pendingJoin: false, tokensFlipped: 0, joinOrder: 1, hasBeenInsiderThisGame: false },
        { id: 'p3', displayName: 'April', teamId: 'B', connected: true, isHost: false, canHostCast: false, pendingJoin: false, tokensFlipped: 0, joinOrder: 2, hasBeenInsiderThisGame: true },
        { id: 'p4', displayName: 'Nell', teamId: 'B', connected: true, isHost: false, canHostCast: false, pendingJoin: false, tokensFlipped: 0, joinOrder: 3, hasBeenInsiderThisGame: false },
      ],
      round: {
        roundNumber: 1,
        insiders: [
          { insiderPlayerId: 'p1', submitted: false, submittedAt: null, clueBoards: [] },
          { insiderPlayerId: 'p3', submitted: false, submittedAt: null, clueBoards: [] },
        ],
        firstInsiderPlayerId: null,
        activeGuessing: null,
      },
    });
    const priv = makePriv({ playerId: 'p2', teamId: 'A', isInsider: false });
    render(<WriteClues pub={teamPub} priv={priv} />);
    expect(screen.getByText('Insiders are writing clues…')).toBeInTheDocument();
  });
});

describe('3-Player Mode role badge', () => {
  it.each([
    ['INSIDER', '🕵️ You: Insider'],
    ['INTERCEPTOR', '🎯 You: Interceptor'],
    ['CONTACT', '📣 You: Contact'],
  ] as const)('shows "%s" role as a badge during clue writing', (role, label) => {
    const { pub, priv } = threePlayerFixture(role);
    render(<WriteClues pub={pub} priv={priv} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('does not show a role badge in TEAM mode', () => {
    const teamPub = makePub({
      mode: 'TEAM',
      players: [
        { id: 'p1', displayName: 'Eric', teamId: 'A', connected: true, isHost: true, canHostCast: true, pendingJoin: false, tokensFlipped: 0, joinOrder: 0, hasBeenInsiderThisGame: true },
        { id: 'p2', displayName: 'Lincoln', teamId: 'A', connected: true, isHost: false, canHostCast: false, pendingJoin: false, tokensFlipped: 0, joinOrder: 1, hasBeenInsiderThisGame: false },
        { id: 'p3', displayName: 'April', teamId: 'B', connected: true, isHost: false, canHostCast: false, pendingJoin: false, tokensFlipped: 0, joinOrder: 2, hasBeenInsiderThisGame: true },
        { id: 'p4', displayName: 'Nell', teamId: 'B', connected: true, isHost: false, canHostCast: false, pendingJoin: false, tokensFlipped: 0, joinOrder: 3, hasBeenInsiderThisGame: false },
      ],
      round: {
        roundNumber: 1,
        insiders: [
          { insiderPlayerId: 'p1', submitted: false, submittedAt: null, clueBoards: [] },
          { insiderPlayerId: 'p3', submitted: false, submittedAt: null, clueBoards: [] },
        ],
        firstInsiderPlayerId: null,
        activeGuessing: null,
      },
    });
    const priv = makePriv({ playerId: 'p2', teamId: 'A', isInsider: false });
    render(<WriteClues pub={teamPub} priv={priv} />);
    expect(screen.queryByText(/You: /)).not.toBeInTheDocument();
  });

  it('keeps showing the role badge through the Guessing screen', () => {
    const { pub, priv } = threePlayerFixture('CONTACT');
    const g = {
      insiderPlayerId: 'p1',
      contactTeam: null,
      interceptTeam: null,
      steps: [
        { guessingTeam: null, guessingRole: 'INTERCEPTOR' as const, flippedSlot: null, spokenResult: null },
        { guessingTeam: null, guessingRole: 'INTERCEPTOR' as const, flippedSlot: null, spokenResult: null },
        { guessingTeam: null, guessingRole: 'CONTACT' as const, flippedSlot: null, spokenResult: null },
      ],
      currentStepIndex: 0,
      resolved: false,
      resolution: null,
      revealedCategory: null,
    };
    const guessingPub = makePub({
      ...pub,
      phase: 'GUESS_FIRST',
      round: { ...pub.round!, activeGuessing: g },
    });
    render(<Guessing pub={guessingPub} priv={priv} />);
    expect(screen.getByText('📣 You: Contact')).toBeInTheDocument();
  });
});
