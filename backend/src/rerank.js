/**
 * Ingredient-overlap re-ranking -- the one real divergence from the reference
 * project's retrieval.
 *
 * vectorStore.retrieve() hands back a POOL of candidates ordered by semantic
 * similarity alone (see its own comment for why the two signals are kept
 * separate). This module re-sorts that pool by a much more literal signal:
 * of a recipe's main ingredients, what fraction does the user actually say
 * they have? That question has nothing to do with embedding distance, so it
 * gets its own pass rather than being folded into the SQL query.
 *
 * Kept standalone (not inside vectorStore.js) so the overlap math can be unit
 * tested with plain objects, no database involved, and so /api/search can
 * expose both the raw pool and the reranked result for debugging.
 */

/** Final number of recipes that make it into the prompt, after reranking. */
export const DEFAULT_TOP_K = () => Number(process.env.RERANK_TOP_K) || 6;

/**
 * Split the user's raw message into ingredient tokens: "chicken, garlic and
 * some rice" -> ["chicken", "garlic", "some rice"]. No stemming, no ingredient
 * database lookup -- just what the user typed, cleaned up enough to compare.
 */
export function parseIngredients(rawMessage) {
  return String(rawMessage ?? '')
    .toLowerCase()
    .split(/,|\band\b|\n/gi)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whole-word/whole-phrase match. Plain `includes` would match "egg" inside
 * "eggplant" or "rice" inside "riced cauliflower", quietly inflating overlap.
 * Reused from the same principle as the reference project's keyword bonus,
 * but used here as the actual membership test rather than a small bonus.
 */
function mentions(haystack, phrase) {
  const p = String(phrase ?? '').trim().toLowerCase();
  if (p.length < 2) return false;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * What fraction of `recipe.mainIngredients` the user's typed ingredients
 * cover, as a number in [0, 1].
 */
export function overlapScore(recipe, userIngredients) {
  const main = recipe.mainIngredients ?? [];
  if (!main.length || !userIngredients.length) return 0;

  const haystack = userIngredients.join(' , ');
  const matched = main.filter((ingredient) => mentions(haystack, ingredient)).length;
  return matched / main.length;
}

/**
 * Re-rank a semantic-search pool by ingredient overlap and take the top
 * `topK`. Semantic score is kept on each hit (as `semantic`) and used only as
 * a tiebreaker -- overlap percentage decides the primary order.
 *
 * @param {{recipe:object, semantic:number, matchedChunk:string, document:string}[]} candidates
 * @param {string} rawMessage   the user's latest message, verbatim
 * @param {{topK?:number}} opts
 * @returns {{recipe:object, semantic:number, overlapPct:number, matchedChunk:string, document:string}[]}
 */
export function byIngredientOverlap(candidates, rawMessage, { topK = DEFAULT_TOP_K() } = {}) {
  const userIngredients = parseIngredients(rawMessage);

  return candidates
    .map((c) => ({ ...c, overlapPct: overlapScore(c.recipe, userIngredients) }))
    .sort((a, b) => b.overlapPct - a.overlapPct || b.semantic - a.semantic)
    .slice(0, topK);
}
