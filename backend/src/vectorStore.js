/**
 * Vector search over the active collection, run by Postgres.
 *
 * The chunk vectors live in a pgvector column and never travel into Node: a
 * query is embedded, handed to Postgres, and the database does the cosine
 * comparison and the ordering. What comes back is one row per recipe.
 *
 * The store searches CHUNKS but returns RECIPES: chunks are scored
 * individually and folded back to one row per recipe, keeping the best
 * score -- the DISTINCT ON below does that folding. (Only one chunk kind
 * exists per recipe here, so this mostly just resolves the join; the shape
 * is kept the same as the reference project's field-split-aware store.)
 *
 * retrieve() returns a POOL of candidates by semantic similarity only --
 * ranking by ingredient overlap happens one step later, in rerank.js. This
 * module never combines the two: it hands back the semantic score, and
 * nothing else, so the two ranking signals stay easy to reason about
 * independently.
 *
 * The recipe records themselves are cached in memory when a collection is
 * activated. They are small, several endpoints want them synchronously, and
 * keeping them here means a search is one round trip rather than two.
 */

import { embed } from './gemini.js';
import { toDocument } from './pipeline/chunk.js';
import { query, toVectorLiteral } from './db.js';
import {
  activeCollectionId,
  countUsableEntries,
  readRecipes,
  readManifest,
} from './collections.js';

/**
 * Below this score a "match" is noise. Without a floor, "how do I fix my car"
 * still hands the model twelve recipes and invites it to recommend one.
 *
 * gemini-embedding-001 has a high similarity baseline -- unrelated text does
 * not score near zero. Re-check this if you change embed model, the same way
 * the reference project calibrates it against its own catalog.
 */
const MIN_SCORE = () => Number(process.env.MIN_SCORE ?? 0.58);

/** Pool size for the semantic search, BEFORE the ingredient-overlap rerank. */
export const DEFAULT_K = () => Number(process.env.RETRIEVE_K) || 12;

let state = null; // { collectionId, name, chunkStrategy, recipes:Map, chunks, model, dims }

export function isReady() {
  return state !== null;
}

export function size() {
  return state?.recipes.size ?? 0;
}

export function chunkCount() {
  return state?.chunks ?? 0;
}

/** In-memory, so the catalog endpoint no longer re-reads and re-parses on every hit. */
export function allRecipes() {
  return state ? [...state.recipes.values()] : [];
}

export function activeInfo() {
  if (!state) return null;
  return {
    id: state.collectionId,
    name: state.name,
    recipes: state.recipes.size,
    chunks: state.chunks,
    chunkStrategy: state.chunkStrategy,
    model: state.model,
    dims: state.dims,
  };
}

/** Tag an error with the HTTP status it should surface as. */
function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Load a collection and make it live.
 * Called at boot and again on activation, so switching catalogs needs no restart.
 */
export async function swapIndex(collectionId) {
  const id = collectionId ?? (await activeCollectionId());
  if (!id) throw new Error('No catalog is currently loaded.');

  const manifest = await readManifest(id);
  if (!manifest) throw fail(`Collection ${id} not found`, 404);
  if (manifest.status !== 'ready') {
    throw fail(
      `Collection ${id} is "${manifest.status}", so there is nothing to serve yet`,
      409
    );
  }

  const { embedded, usable } = await countUsableEntries(id);
  if (!embedded) throw fail(`Collection ${id} has no embeddings`, 409);
  if (!usable) throw fail(`Collection ${id} produced no usable entries`, 409);

  const recipes = new Map((await readRecipes(id)).map((r) => [r.id, r]));

  state = {
    collectionId: id,
    name: manifest.name,
    chunkStrategy: manifest.chunkStrategy,
    recipes,
    chunks: usable,
    model: manifest.model,
    dims: manifest.dims,
  };
  console.log(`[rag] active collection ${id} -- ${recipes.size} recipes, ${usable} chunks`);
  return activeInfo();
}

/**
 * The optional hard filters from the UI (cuisine / diet tag dropdowns), as
 * SQL fragments over the recipe's JSON record. `sql` takes the placeholder to
 * bind against, because the same clause is used by queries that carry a
 * different number of leading parameters.
 */
function filterSpecs(filters) {
  const specs = [];
  if (typeof filters.cuisine === 'string' && filters.cuisine) {
    specs.push({
      value: filters.cuisine.toLowerCase(),
      sql: (p) => `lower(coalesce(r.data->>'cuisine', '')) = ${p}`,
    });
  }
  if (typeof filters.dietTag === 'string' && filters.dietTag) {
    specs.push({
      value: filters.dietTag.toLowerCase(),
      sql: (p) =>
        `EXISTS (SELECT 1 FROM jsonb_array_elements_text(jsonb_list(r.data, 'dietTags')) g
                  WHERE lower(g) = ${p})`,
    });
  }
  return specs;
}

/**
 * Narrow by one filter at a time, keeping each only if the catalog still has
 * something in it afterwards -- the dropdowns narrow the catalog, they never
 * empty it. Dropping just the filter that went too far (rather than all of
 * them) is what keeps "vegan" honoured when the cuisine alongside it happens
 * to match no vegan recipe.
 */
async function keepUsableFilters(collectionId, specs) {
  const kept = [];
  for (const spec of specs) {
    const candidate = [...kept, spec];
    const clauses = candidate.map((s, i) => s.sql(`$${i + 2}`));
    const { rows } = await query(
      `SELECT 1 FROM recipes r
        WHERE r.collection_id = $1 AND ${clauses.join(' AND ')} LIMIT 1`,
      [collectionId, ...candidate.map((s) => s.value)]
    );
    if (rows.length) kept.push(spec);
  }
  return kept;
}

/**
 * Retrieve the top-k most semantically similar RECIPES for a query. This is
 * the candidate POOL, not the final answer -- rerank.js narrows and reorders
 * it by ingredient overlap before anything reaches the prompt.
 */
export async function retrieve(queryText, { k = DEFAULT_K(), filters = {} } = {}) {
  if (!state) throw new Error('Index not loaded yet.');

  const queryVector = await embed(queryText, 'RETRIEVAL_QUERY');
  const vector = toVectorLiteral(queryVector);
  const floor = MIN_SCORE();

  const kept = await keepUsableFilters(state.collectionId, filterSpecs(filters));
  const filterSql = kept.length
    ? `AND ${kept.map((s, i) => s.sql(`$${i + 4}`)).join(' AND ')}`
    : '';
  const safeK = Number(k) > 0 ? Number(k) : DEFAULT_K();
  const params = [
    state.collectionId,
    vector,
    floor,
    ...kept.map((s) => s.value),
    safeK,
  ];
  const limitPlaceholder = `$${params.length}`;

  // DISTINCT ON keeps each recipe's single best-matching chunk. The vectors
  // are unit-normalised at embed time, so 1 - cosine_distance is the cosine
  // similarity.
  const { rows } = await query(
    `SELECT recipe_id, kind, semantic FROM (
       SELECT DISTINCT ON (c.recipe_id)
              c.recipe_id,
              c.kind,
              1 - (c.embedding <=> $2::vector) AS semantic
         FROM chunks c
         JOIN recipes r ON r.collection_id = c.collection_id AND r.recipe_id = c.recipe_id
        WHERE c.collection_id = $1
          AND c.embedding IS NOT NULL
          ${filterSql}
        ORDER BY c.recipe_id, c.embedding <=> $2::vector
     ) best
     WHERE semantic >= $3
     ORDER BY semantic DESC
     LIMIT ${limitPlaceholder}`,
    params
  );

  const hits = [];
  for (const row of rows) {
    const recipe = state.recipes.get(row.recipe_id);
    if (!recipe) continue;
    hits.push({
      recipe,
      semantic: row.semantic,
      matchedChunk: row.kind,
      // The prompt always gets the FULL record, never just the chunk that
      // matched.
      document: toDocument(recipe),
    });
  }
  return hits;
}
