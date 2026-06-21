// Automated validation pipeline for AI-generated options (§4.12).
// Runs before any option may enter its category pool.
import { type Category } from '@triangulation/shared';
import { normalizeText } from '../engine/cards.js';

// Lightweight blocklist; production would source a fuller list.
const BLOCKLIST = [
  'nigger', 'faggot', 'cunt', 'rape', 'rapist', 'nazi', 'hitler', 'kike',
  'spic', 'chink', 'retard', 'molest', 'pedophile', 'porn',
];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Proper-noun shape: a name, not a generic word/phrase. */
function looksLikeProperNoun(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 60) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  // at least one capitalized token (after stripping leading articles)
  const significant = words.filter((w) => !/^(the|a|an|of|and|de|la|le)$/i.test(w));
  if (significant.length === 0) return false;
  return significant.some((w) => /^[A-Z0-9]/.test(w));
}

export function validateOption(
  category: Category,
  text: string,
  excludeNormalized: ReadonlySet<string>,
): ValidationResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (!looksLikeProperNoun(trimmed)) return { ok: false, reason: 'not-proper-noun' };

  const lower = trimmed.toLowerCase();
  if (BLOCKLIST.some((bad) => lower.includes(bad))) return { ok: false, reason: 'blocked' };

  // dedupe against already-served / pooled
  if (excludeNormalized.has(normalizeText(trimmed))) return { ok: false, reason: 'duplicate' };

  return { ok: true };
}
