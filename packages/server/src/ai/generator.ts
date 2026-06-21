// AI message generation (PRD §4.12). Generates large batches per category via
// the Anthropic Messages API with structured outputs, validates each option,
// and feeds per-category validated pools. Generation is server-side only.
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORY_LABELS, type Category, type Difficulty } from '@triangulation/shared';
import { validateOption } from './validation.js';

const DIFFICULTY_GUIDANCE: Record<Difficulty, string> = {
  EASY: 'globally famous, household names almost anyone would recognize',
  MEDIUM: 'well-known but not the most obvious — recognizable to most adults',
  HARD: 'niche or specialist — known to enthusiasts, not the general public',
};

const CATEGORY_GUIDANCE: Record<Category, string> = {
  C: 'fictional characters (from books, films, TV, games, comics)',
  M: 'media titles (films, TV shows, books, video games, albums)',
  P: 'real people (living or historical)',
  L: 'real geographic locations (cities, countries, landmarks, regions)',
  B: 'brands or companies',
  W: 'wildcard — any famous proper noun that does not cleanly fit the other categories',
};

export interface GeneratorOptions {
  apiKey: string;
  model: string;
}

export class MessageGenerator {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: GeneratorOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  /**
   * Generate a batch of validated proper-noun options for one category at one
   * difficulty. Returns only options that pass automated validation (§4.12).
   */
  async generateBatch(
    category: Category,
    difficulty: Difficulty,
    count: number,
    excludeNormalized: ReadonlySet<string>,
  ): Promise<string[]> {
    const prompt =
      `Generate ${count} distinct proper-noun answers for a party guessing game.\n` +
      `Category: ${CATEGORY_LABELS[category]} — ${CATEGORY_GUIDANCE[category]}.\n` +
      `Difficulty: ${DIFFICULTY_GUIDANCE[difficulty]}.\n` +
      `Rules: each must be a real proper name (1-4 words), not a generic word or phrase. ` +
      `No duplicates. No offensive or adult content.\n` +
      `Respond with ONLY a JSON object of the form {"names": ["...", "..."]} and nothing else.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal') return [];

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') return [];

    const names = extractNames(text.text);

    const seen = new Set(excludeNormalized);
    const valid: string[] = [];
    for (const n of names) {
      const res = validateOption(category, n, seen);
      if (res.ok) {
        valid.push(n.trim());
        seen.add(n.trim().toLowerCase());
      }
    }
    return valid;
  }
}

/** Robustly pull the names array out of the model's reply (JSON-first). */
function extractNames(raw: string): string[] {
  // Prefer a JSON object/array embedded anywhere in the reply.
  const jsonMatch = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const arr = Array.isArray(parsed) ? parsed : parsed?.names;
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    } catch {
      /* fall through to line parsing */
    }
  }
  // Fallback: one name per line, stripping list markers.
  return raw
    .split('\n')
    .map((l) => l.replace(/^[\s\-*\d.)"']+/, '').replace(/["',]+$/, '').trim())
    .filter((l) => l.length > 0 && l.length < 60);
}
