/**
 * The RAG pipeline: rewrite -> retrieve -> rerank -> augment -> generate.
 *
 * Two ranking signals, kept deliberately separate through the whole pipeline:
 *   - semantic similarity (vectorStore.retrieve) builds a pool of 12 recipes
 *     that are plausibly relevant to what the user is asking for.
 *   - ingredient overlap (rerank.byIngredientOverlap) decides which 6 of
 *     those 12 actually get recommended, based on what the user says they
 *     have on hand.
 */

import { generate } from './gemini.js';
import { DEFAULT_K, retrieve } from './vectorStore.js';
import { byIngredientOverlap, DEFAULT_TOP_K } from './rerank.js';

/**
 * Turn a follow-up like "make it vegetarian instead" into a standalone search
 * query, because embedding it on its own retrieves nothing useful. Cheap
 * heuristic first, one small LLM call only when the message really is
 * context-dependent.
 */
async function buildSearchQuery(message, history) {
  if (history.length === 0) return message;
  if (message.split(/\s+/).length > 12) return message; // already self-contained

  // Rewriting costs a second chat call per turn. On the free tier that halves how
  // many questions you can ask before hitting the quota, so allow turning it off.
  if (process.env.ENABLE_QUERY_REWRITE === 'false') return message;

  const transcript = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Cook' : 'Bot'}: ${m.text}`)
    .join('\n');

  try {
    const rewritten = await generate({
      system:
        'You rewrite a home cook\'s latest message into a single standalone recipe-search query. ' +
        'Fold in any cuisine, diet or time constraint implied by the conversation. ' +
        'Reply with the query only -- no quotes, no preamble, no explanation.',
      message: `Conversation so far:\n${transcript}\n\nLatest message: ${message}\n\nStandalone search query:`,
      temperature: 0,
    });
    const clean = rewritten.trim().split('\n')[0].slice(0, 300);
    return clean || message;
  } catch {
    return message; // rewriting is an optimisation, never a hard dependency
  }
}

const SYSTEM_RULES = `You are ChefMind, a warm and practical recipe recommendation assistant.

HOW TO ANSWER
- Recommend ONLY recipes from the CATALOG below. Never invent a title, ingredient, or step.
- Normally suggest 2-4 recipes, best match first. If the cook asks for one, give one.
- For each: **Title** (cuisine), then 1-2 sentences on why it fits what they have, plus how much of the ingredient list they already have on hand, time and servings.
- Tie every recommendation back to the ingredients they actually listed ("since you've got chicken and rice...").
- Mention any missing main ingredients plainly, and call out relevant diet tags.
- Ask one short follow-up question at the end (e.g. swap a diet, more/less time).

WHEN THE CATALOG FALLS SHORT
- If nothing is a good fit, say so plainly and offer the closest options as "not exactly what you've got, but...".
- If a cook names a dish that is not in the catalog, say you do not have it, then recommend catalog recipes that are similar.
- Never pad an answer with recipes you were not given.

STYLE
- Conversational and encouraging, never a sales pitch. Use markdown. Keep it under ~250 words.`;

function formatContext(hits) {
  return hits
    .map(
      (h, i) =>
        `--- CATALOG ENTRY ${i + 1} (ingredient match ${Math.round(h.overlapPct * 100)}%, relevance ${h.semantic.toFixed(3)}) ---\n${h.document}`
    )
    .join('\n\n');
}

/**
 * Answer one chat turn.
 * @param {string} message
 * @param {{role:'user'|'model',text:string}[]} history
 * @param {{cuisine?:string, dietTag?:string}} filters
 */
export async function answer({ message, history = [], filters = {} }) {
  const searchQuery = await buildSearchQuery(message, history);
  const pool = await retrieve(searchQuery, { k: DEFAULT_K(), filters });

  // Ingredient parsing always reads the raw latest message, never the
  // rewritten search query -- rewriting is about search intent ("what is
  // this conversation asking for"), not about what is literally in the
  // user's pantry right now.
  const hits = byIngredientOverlap(pool, message, { topK: DEFAULT_TOP_K() });

  // Retrieval applies a relevance floor, so an off-topic question legitimately
  // returns nothing. Say so explicitly rather than sending an empty CATALOG
  // block, which reads to the model like a formatting glitch.
  const catalogBlock = hits.length
    ? formatContext(hits)
    : '(No catalog entry was a close enough match for this request.)';

  const system = `${SYSTEM_RULES}

=========================
CATALOG (the only recipes you may recommend)
=========================
${catalogBlock}`;

  const text = await generate({ system, history, message });

  return {
    answer: text,
    searchQuery,
    // Sent to the UI so the user can see what retrieval and reranking
    // actually did -- the single most useful thing to expose when debugging
    // a RAG app. `score` is what decided the order (ingredient overlap);
    // `similarity` is the semantic score that built the candidate pool.
    sources: hits.map((h) => ({
      id: h.recipe.id,
      title: h.recipe.title,
      cuisine: h.recipe.cuisine,
      dietTags: h.recipe.dietTags,
      timeMinutes: h.recipe.timeMinutes,
      servings: h.recipe.servings,
      score: Number(h.overlapPct.toFixed(4)),
      similarity: Number(h.semantic.toFixed(4)),
    })),
  };
}
