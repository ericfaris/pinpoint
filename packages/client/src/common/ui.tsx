import { useEffect, useState } from 'react';
import {
  CATEGORY_LABELS,
  TOKENS_TO_WIN,
  type BoardSlot,
  type Category,
  type PublicClueBoard,
} from '@pinpoint/shared';
import { useGame } from './useGame.js';

export function Tokens({ count, big }: { count: number; big?: boolean }) {
  return (
    <span className={`tokens${big ? ' bigtokens' : ''}`}>
      {Array.from({ length: TOKENS_TO_WIN }).map((_, i) => (
        <span key={i} className={`token${i < count ? ' on' : ''}`} />
      ))}
    </span>
  );
}

export function CategoryTag({ category }: { category: Category }) {
  return (
    <span className={`tag ${category}`} title={CATEGORY_LABELS[category]}>
      {category}
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
  const cls = board.faceUp ? 'up' : 'down';
  if (board.faceUp) {
    return (
      <div className={`board ${cls}`}>
        <div>
          <div className="muted small">Board {board.slot}</div>
          <div className="word">{board.clue || '—'}</div>
        </div>
      </div>
    );
  }
  if (flippable && onFlip) {
    return (
      <button className={`board ${cls}`} onClick={() => onFlip(board.slot)}>
        <div>
          <div className="muted small">Board {board.slot}</div>
          <div>Tap to flip</div>
        </div>
      </button>
    );
  }
  return (
    <div className={`board ${cls}`}>
      <div className="muted">Board {board.slot}</div>
    </div>
  );
}
