import { useEffect, useRef } from 'react';
import type { PublicRoom } from '@pinpoint/shared';

/**
 * Cold War "audio dispatch" cues for the TV — see design/DESIGN-SYSTEM.md.
 * A handler voice over radio static: a round opens, a target is acquired, or
 * the intel is compromised. Cues fire off derived state changes in the
 * spectator projection, so they stay in lock-step with what the room sees.
 *
 * Playback is best-effort: on a Cast device audio just plays; in a plain
 * browser tab the first cue may be blocked until someone interacts with the
 * page. We never surface that as an error.
 */
const CUES = {
  roundOpen: '/cue-round-open.mp3',
  correct: '/cue-correct.mp3',
  incorrect: '/cue-incorrect.mp3',
} as const;

export function useReceiverAudio(pub: PublicRoom | null): void {
  const els = useRef<Record<keyof typeof CUES, HTMLAudioElement> | undefined>(undefined);
  const prevPhase = useRef<string | null>(null);
  const prevResolvedCount = useRef(0);

  // Build the <audio> elements once, on mount.
  useEffect(() => {
    const built = {} as Record<keyof typeof CUES, HTMLAudioElement>;
    (Object.keys(CUES) as (keyof typeof CUES)[]).forEach((k) => {
      const a = new Audio(CUES[k]);
      a.preload = 'auto';
      a.volume = 0.85;
      built[k] = a;
    });
    els.current = built;
  }, []);

  const play = (k: keyof typeof CUES) => {
    const a = els.current?.[k];
    if (!a) return;
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  };

  useEffect(() => {
    if (!pub) {
      prevPhase.current = null;
      prevResolvedCount.current = 0;
      return;
    }

    // Round / message opens: entering a guessing phase.
    const phase = pub.phase;
    const enteringGuess =
      (phase === 'GUESS_FIRST' || phase === 'GUESS_SECOND') && prevPhase.current !== phase;
    if (enteringGuess) play('roundOpen');
    prevPhase.current = phase;

    // Target acquired / intel compromised: a spoken result was just recorded.
    const steps = pub.round?.activeGuessing?.steps ?? [];
    const resolved = steps.filter((s) => s.spokenResult !== null);
    if (resolved.length > prevResolvedCount.current) {
      const latest = resolved[resolved.length - 1]!;
      play(latest.spokenResult === 'CORRECT' ? 'correct' : 'incorrect');
    }
    // Reset the counter when a new message begins (steps list swaps out).
    prevResolvedCount.current = resolved.length;
  }, [pub]);
}
