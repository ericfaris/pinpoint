// Hybrid buffer (PRD §4.12 / §9.2): per-category validated pools, each option
// tagged with a difficulty so cards can be assembled to match a room's setting
// on demand. Refilled in the background as consumed. Falls back to a bundled
// seed set (synthetic source) when generation is unavailable / pools are dry.
import {
  CATEGORIES,
  type Category,
  type Difficulty,
  type MessageCard,
  type MessageOption,
} from '@pinpoint/shared';
import { type CardSource, SyntheticCardSource, nextCardId, normalizeText } from '../engine/cards.js';
import { makeRng } from '../engine/rng.js';
import type { MessageGenerator } from './generator.js';

interface PooledOption {
  text: string;
  difficulty: Difficulty;
}

const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];

export interface BufferConfig {
  /** target pool size per (category, difficulty) */
  targetPerTier?: number;
  /** refill when a tier drops to/below this */
  refillThreshold?: number;
  /** how many to request per generation call */
  batchSize?: number;
}

export class CardBuffer implements CardSource {
  private pools: Record<Category, PooledOption[]>;
  /** every normalized text ever pooled, to avoid cross-batch duplicates */
  private readonly known = new Set<string>();
  private readonly seed: SyntheticCardSource;
  private readonly refilling = new Set<string>();
  private readonly target: number;
  private readonly threshold: number;
  private readonly batchSize: number;

  constructor(
    private readonly generator: MessageGenerator | null,
    config: BufferConfig = {},
  ) {
    this.pools = { C: [], M: [], P: [], L: [], B: [], W: [] };
    this.seed = new SyntheticCardSource(makeRng());
    this.target = config.targetPerTier ?? 24;
    this.threshold = config.refillThreshold ?? 8;
    this.batchSize = config.batchSize ?? 24;
  }

  /** Synchronous deal used by the engine. Draws one option per category. */
  deal(difficulty: Difficulty, excludeNormalized: ReadonlySet<string>): MessageCard | null {
    const options: MessageOption[] = [];
    const usedThisCard = new Set<string>();

    for (const category of CATEGORIES) {
      const opt = this.takeFromPool(category, difficulty, excludeNormalized, usedThisCard);
      if (opt) {
        usedThisCard.add(normalizeText(opt));
        options.push({ category, text: opt });
      } else {
        // Pool dry for this category/difficulty — fall back to the seed set for
        // just this option rather than failing the whole card.
        const exclude = new Set([...excludeNormalized, ...usedThisCard]);
        const seedCard = this.seed.deal(difficulty, exclude);
        const seedOpt = seedCard?.options.find((o) => o.category === category);
        if (!seedOpt) return null;
        usedThisCard.add(normalizeText(seedOpt.text));
        options.push(seedOpt);
      }
    }

    this.maybeRefillAll(difficulty);
    return { id: nextCardId(), options };
  }

  private takeFromPool(
    category: Category,
    difficulty: Difficulty,
    excludeNormalized: ReadonlySet<string>,
    usedThisCard: ReadonlySet<string>,
  ): string | null {
    const pool = this.pools[category];
    // prefer the room's difficulty; allow any tier as a graceful fallback
    const idxExact = pool.findIndex(
      (o) =>
        o.difficulty === difficulty &&
        !excludeNormalized.has(normalizeText(o.text)) &&
        !usedThisCard.has(normalizeText(o.text)),
    );
    const idx =
      idxExact >= 0
        ? idxExact
        : pool.findIndex(
            (o) =>
              !excludeNormalized.has(normalizeText(o.text)) &&
              !usedThisCard.has(normalizeText(o.text)),
          );
    if (idx < 0) return null;
    const [opt] = pool.splice(idx, 1);
    return opt!.text;
  }

  /** Kick off background refills for any tier under threshold. */
  private maybeRefillAll(currentDifficulty: Difficulty): void {
    if (!this.generator) return;
    for (const category of CATEGORIES) {
      const have = this.pools[category].filter((o) => o.difficulty === currentDifficulty).length;
      if (have <= this.threshold) {
        void this.refill(category, currentDifficulty);
      }
    }
  }

  /** Pre-warm pools at startup so the first cards are AI-generated. */
  async warmup(difficulties: Difficulty[] = DIFFICULTIES): Promise<void> {
    if (!this.generator) return;
    await Promise.all(
      difficulties.flatMap((d) => CATEGORIES.map((c) => this.refill(c, d))),
    );
  }

  private async refill(category: Category, difficulty: Difficulty): Promise<void> {
    if (!this.generator) return;
    const key = `${category}:${difficulty}`;
    if (this.refilling.has(key)) return;
    const have = this.pools[category].filter((o) => o.difficulty === difficulty).length;
    if (have >= this.target) return;
    this.refilling.add(key);
    try {
      const fresh = await this.generator.generateBatch(
        category,
        difficulty,
        this.batchSize,
        this.known,
      );
      for (const text of fresh) {
        const norm = normalizeText(text);
        if (this.known.has(norm)) continue;
        this.known.add(norm);
        this.pools[category].push({ text, difficulty });
      }
    } catch (e) {
      // Generation failed — seed fallback covers gameplay; log and move on.
      console.error(`[card-buffer] refill ${key} failed:`, (e as Error).message);
    } finally {
      this.refilling.delete(key);
    }
  }

  stats(): Record<Category, number> {
    return {
      C: this.pools.C.length,
      M: this.pools.M.length,
      P: this.pools.P.length,
      L: this.pools.L.length,
      B: this.pools.B.length,
      W: this.pools.W.length,
    };
  }
}
