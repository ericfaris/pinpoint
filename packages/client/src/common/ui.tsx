import { useEffect, useState } from 'react';
import {
  CATEGORY_LABELS,
  TOKENS_TO_WIN,
  type BoardSlot,
  type Category,
  type PublicClueBoard,
  type TeamId,
} from '@pinpoint/shared';
import { useGame } from './useGame.js';

/** Five/six-pointed star outline centered at (cx, cy), for stamped-medallion art. */
function starPath(cx: number, cy: number, rOuter: number, rInner: number, points = 5): string {
  const step = Math.PI / points;
  const parts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const angle = -Math.PI / 2 + i * step;
    const x = (cx + r * Math.cos(angle)).toFixed(2);
    const y = (cy + r * Math.sin(angle)).toFixed(2);
    parts.push(`${i === 0 ? 'M' : 'L'}${x},${y}`);
  }
  return `${parts.join(' ')} Z`;
}

/**
 * Cold War dossier-style pictogram for each message category. Drawn in
 * `currentColor` (the tag's cream foreground) with an ink outline so it sits
 * on the category's stamp color exactly like the letter it replaces.
 */
function CategoryIcon({ category }: { category: Category }) {
  const ink = { stroke: 'var(--line)' };
  switch (category) {
    case 'C': // Character — trench coat, fedora, magnifying glass
      return (
        <svg viewBox="0 0 100 100" className="cicon" aria-hidden="true">
          <g fill="currentColor" strokeWidth="5" strokeLinejoin="round" style={ink}>
            <path d="M30 42 Q50 16 70 42 L70 46 L30 46 Z" />
            <ellipse cx="50" cy="46" rx="27" ry="7" />
            <path d="M22 92 L34 58 L66 58 L78 92 Z" />
          </g>
          <path d="M50 58 L41 76 L50 70 L59 76 Z" fill="var(--line)" />
          <g fill="none" strokeWidth="5" strokeLinecap="round" style={ink}>
            <circle cx="74" cy="76" r="11" />
            <line x1="82" y1="84" x2="92" y2="94" />
          </g>
        </svg>
      );
    case 'M': // Media — reel-to-reel deck, broadcast waves
      return (
        <svg viewBox="0 0 100 100" className="cicon" aria-hidden="true">
          <g fill="currentColor" strokeWidth="5" strokeLinejoin="round" style={ink}>
            <rect x="14" y="64" width="72" height="18" rx="4" />
            <circle cx="34" cy="64" r="16" />
            <circle cx="66" cy="64" r="16" />
          </g>
          <g fill="var(--line)">
            <circle cx="34" cy="64" r="5" />
            <circle cx="66" cy="64" r="5" />
          </g>
          <g fill="none" strokeWidth="5" strokeLinecap="round" style={ink}>
            <path d="M40 40 Q50 30 60 40" />
            <path d="M33 30 Q50 12 67 30" />
          </g>
        </svg>
      );
    case 'P': // Person — dossier photo, fingerprint
      return (
        <svg viewBox="0 0 100 100" className="cicon" aria-hidden="true">
          <rect x="22" y="14" width="56" height="72" rx="6" fill="currentColor" strokeWidth="5" style={ink} />
          <g fill="none" strokeWidth="3.5" style={ink}>
            <ellipse cx="50" cy="52" rx="21" ry="25" />
            <ellipse cx="50" cy="52" rx="14" ry="17" />
            <ellipse cx="50" cy="52" rx="7" ry="9" />
          </g>
        </svg>
      );
    case 'L': // Location — triangulated map pin
      return (
        <svg viewBox="0 0 100 100" className="cicon" aria-hidden="true">
          <g fill="none" strokeWidth="4" strokeDasharray="4 5" strokeLinecap="round" style={ink}>
            <line x1="16" y1="16" x2="50" y2="58" />
            <line x1="84" y1="16" x2="50" y2="58" />
          </g>
          <g fill="var(--line)">
            <circle cx="16" cy="16" r="5" />
            <circle cx="84" cy="16" r="5" />
          </g>
          <path
            d="M32 42 A18 18 0 1 1 68 42 L50 88 Z"
            fill="currentColor"
            strokeWidth="5"
            strokeLinejoin="round"
            style={ink}
          />
          <circle cx="50" cy="42" r="7" fill="var(--line)" />
        </svg>
      );
    case 'B': // Brand — stenciled contraband crate
      return (
        <svg viewBox="0 0 100 100" className="cicon" aria-hidden="true">
          <rect x="16" y="26" width="68" height="58" rx="3" fill="currentColor" strokeWidth="5" style={ink} />
          <g fill="none" strokeWidth="3.5" style={ink}>
            <line x1="16" y1="26" x2="84" y2="84" />
            <line x1="84" y1="26" x2="16" y2="84" />
          </g>
          <path d={starPath(50, 55, 11, 4.5)} fill="var(--line)" />
        </svg>
      );
    case 'W': // Wildcard — redacted dossier page
    default:
      return (
        <svg viewBox="0 0 100 100" className="cicon" aria-hidden="true">
          <rect x="18" y="14" width="64" height="72" rx="4" fill="currentColor" strokeWidth="5" style={ink} />
          <g fill="var(--line)">
            <rect x="26" y="22" width="48" height="10" rx="2" />
            <rect x="26" y="68" width="48" height="10" rx="2" />
          </g>
          <text x="50" y="60" textAnchor="middle" fontSize="34" fontWeight="900" fill="var(--line)">
            ?
          </text>
        </svg>
      );
  }
}

/**
 * Circular Cold War crest for a team: a cream medallion ring around the
 * team color, with overt Soviet (star + hammer-and-sickle) or American
 * (spread-wing eagle + stars) iconography.
 */
export function TeamCrest({ team, className = '' }: { team: TeamId; className?: string }) {
  const teamVar = team === 'A' ? 'var(--teamA)' : 'var(--teamB)';
  return (
    <span className={`crest ${className}`} title={`Team ${team}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="47" fill="var(--panel)" stroke="var(--line)" strokeWidth="5" />
        <circle cx="50" cy="50" r="38" fill={teamVar} stroke="var(--line)" strokeWidth="3" />
        {team === 'A' ? (
          <g>
            <path
              d={starPath(50, 42, 24, 10)}
              fill="var(--panel)"
              stroke="var(--line)"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <g stroke="var(--line)" strokeWidth="1.5" strokeLinecap="round">
              <line x1="36" y1="76" x2="60" y2="64" stroke="var(--warn)" strokeWidth="7" />
              <path d="M42 62 A11 11 0 1 0 62 76" fill="none" stroke="var(--warn)" strokeWidth="7" />
            </g>
          </g>
        ) : (
          <g>
            <path
              d="M50 34 L20 58 L34 51 L50 62 L66 51 L80 58 Z"
              fill="var(--panel)"
              stroke="var(--line)"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <circle cx="50" cy="28" r="8" fill="var(--panel)" stroke="var(--line)" strokeWidth="2.5" />
            <path d="M45 29 L36 25 L45 34 Z" fill="var(--warn)" />
            {[-24, -12, 0, 12, 24].map((dx) => (
              <path key={dx} d={starPath(50 + dx, 78, 6, 2.5)} fill="var(--warn)" />
            ))}
          </g>
        )}
      </svg>
    </span>
  );
}

export function Tokens({ count, big }: { count: number; big?: boolean }) {
  return (
    <span className={`tokens${big ? ' bigtokens' : ''}`}>
      {Array.from({ length: TOKENS_TO_WIN }).map((_, i) => (
        <span key={i} className={`token${i < count ? ' on' : ''}`}>★</span>
      ))}
    </span>
  );
}

export function CategoryTag({ category }: { category: Category }) {
  return (
    <span className={`tag ${category}`} title={CATEGORY_LABELS[category]}>
      <CategoryIcon category={category} />
    </span>
  );
}

/** Live countdown driven off a server deadline (ms epoch). */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Timer({
  deadline,
  className = '',
}: {
  deadline: number | null;
  className?: string;
}) {
  const now = useNow();
  const { serverOffset } = useGame();
  if (deadline === null) return null;
  // deadline is a server epoch; reconcile against client clock skew.
  const remaining = Math.ceil((deadline - (now - serverOffset)) / 1000);
  const cls = remaining <= 0 ? 'over' : remaining <= 10 ? 'warn' : '';
  return (
    <span className={`timer ${cls} ${className}`}>{remaining <= 0 ? '0s' : `${remaining}s`}</span>
  );
}

export function Board({
  board,
  onFlip,
  flippable,
}: {
  board: PublicClueBoard;
  onFlip?: (slot: BoardSlot) => void;
  flippable?: boolean;
}) {
  // Both faces are always in the DOM; the wrapper rotates in 3D and each
  // face's backface-visibility:hidden (styles.css) hides whichever one is
  // turned away, producing a card-flip instead of an instant swap.
  const inner = (
    <div className={`board-inner${board.faceUp ? ' flipped' : ''}`}>
      <div className="board-face down">
        <div className="muted small">Board {board.slot}</div>
        {flippable && <div>Tap to flip</div>}
      </div>
      <div className="board-face up">
        <div className="muted small">Board {board.slot}</div>
        <div className="word">{board.clue || '—'}</div>
      </div>
    </div>
  );

  if (!board.faceUp && flippable && onFlip) {
    return (
      <button className="board clickable" onClick={() => onFlip(board.slot)}>
        {inner}
      </button>
    );
  }
  return <div className="board">{inner}</div>;
}
