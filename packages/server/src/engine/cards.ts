// Card source abstraction. The engine depends only on this interface so it
// can be driven by a deterministic source in tests and by the AI buffer
// (with seed-set fallback) in production.
import { CATEGORIES, type Category, type Difficulty, type MessageCard, type MessageOption } from '@pinpoint/shared';
import type { Rng } from './rng.js';

export interface CardSource {
  /**
   * Assemble one card (6 options, one per category), excluding any normalized
   * message texts already served this session. Returns null if it cannot
   * assemble a full unique card.
   */
  deal(difficulty: Difficulty, excludeNormalized: ReadonlySet<string>): MessageCard | null;
}

export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

let cardSeq = 0;
export function nextCardId(): string {
  cardSeq += 1;
  return `card_${cardSeq}_${Date.now().toString(36)}`;
}

/**
 * Deterministic synthetic source used by tests and as the in-memory seed
 * fallback. Generates an effectively unbounded supply of distinct
 * proper-name-shaped strings per category.
 */
export class SyntheticCardSource implements CardSource {
  private counters: Record<Category, number> = { C: 0, M: 0, P: 0, L: 0, B: 0, W: 0 };
  private readonly prefixes: Record<Category, string> = {
    C: 'Captain',
    M: 'The',
    P: 'Doctor',
    L: 'Port',
    B: 'Acme',
    W: 'Mystery',
  };

  constructor(private readonly rng: Rng) {}

  private mint(cat: Category, difficulty: Difficulty): string {
    this.counters[cat] += 1;
    const n = this.counters[cat] + this.rng.int(1000);
    return `${this.prefixes[cat]} ${difficulty[0]}${n}`;
  }

  deal(difficulty: Difficulty, excludeNormalized: ReadonlySet<string>): MessageCard | null {
    const options: MessageOption[] = [];
    for (const category of CATEGORIES) {
      let text = '';
      // synthetic source never realistically exhausts; bounded retry for safety
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = this.mint(category, difficulty);
        if (!excludeNormalized.has(normalizeText(candidate))) {
          text = candidate;
          break;
        }
      }
      if (!text) return null;
      options.push({ category, text });
    }
    return { id: nextCardId(), options };
  }
}
