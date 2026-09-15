# ChefMind — recipe recommendation RAG chatbot — design spec

Date: 2026-09-14
Status: approved by user, pending implementation plan

## Summary

A recipe-recommendation chatbot: users type the ingredients they have and get
recipe suggestions drawn only from an admin-uploaded catalog. Architecture and
file layout mirror the reference project `../reference-bookbot` (a book
recommendation RAG bot) exactly, with one deliberate divergence in the query
pipeline: a 12-candidate vector search re-ranked by ingredient overlap before
the top 6 go to the prompt.

Tech stack: Next.js (frontend) · Express (backend) · Postgres + pgvector
(catalog & search) · Google Gemini API (embeddings + chat generation).

## Non-goals

- No auth beyond the existing single-admin-token pattern (mirrors reference).
- No nutrition data, no user accounts, no recipe ratings/favorites.
- No dual chunk strategy — single blob per recipe only (decided below).

## Two pages

| Page | Who | What |
|---|---|---|
| `/` | home cook | Chat — type ingredients on hand, get recipes |
| `/admin` | catalog owner | Upload a CSV catalog and watch it go through the pipeline |

## Catalog schema

CSV columns: `title, cuisine, diet_tags, main_ingredients,
optional_ingredients, time_minutes, servings, instructions`.

Canonical record (stored as `recipes.data` jsonb):
```
{
  id, title, cuisine,
  dietTags: string[], mainIngredients: string[], optionalIngredients: string[],
  timeMinutes: number|null, servings: number|null, instructions: string
}
```

List fields (`dietTags`, `mainIngredients`, `optionalIngredients`) parse the
same way as the reference's `genres`/`themes`: semicolon-first, else
comma-split, trimmed, empty entries dropped. Header aliases (snake_case,
kebab-case, spaced, camelCase) map onto the canonical keys the same way
`HEADER_ALIASES` does in `pipeline/parse.js`.

## Decided design points

Resolved during brainstorming (see conversation for alternatives considered):

1. **Chunk strategy: single blob only.** One chunk per recipe (`kind: 'full'`),
   no `field-split`/`whole-record` toggle. `CHUNK_STRATEGY` env var and the
   admin UI's strategy picker are dropped entirely — there is nothing to pick.
2. **UI filters: yes.** `/` gets `cuisine` and `dietTags` dropdowns, mirroring
   the reference's `genre`/`readingLevel` hard SQL pre-filters.
3. **App name: ChefMind.** Used as chat persona, page titles, header brand.
4. **Final ranking: pure overlap re-rank.** Within the top-12 semantic pool,
   the final 6 are sorted strictly by ingredient-overlap percentage. Semantic
   score is used only to (a) build the 12-candidate pool and (b) apply the
   `MIN_SCORE` relevance floor — it is not blended into the final order.
5. **Ingredient parsing: simple split, no LLM call.** The user's raw typed
   message is split on commas / " and " / newlines, lowercased, trimmed, empty
   tokens dropped. No stemming, no LLM extraction. This keeps the rerank step
   free (no extra Gemini call), matching the reference's principle that
   query-rewrite is the only optional extra LLM call per turn.

## Backend file layout

Mirrors `reference-bookbot/backend/src/` exactly, `books`→`recipes` renamed
throughout:

```
backend/
  src/server.js          API routes (health, catalog, search, chat, admin mount)
  src/rag.js             rewrite -> retrieve(12) -> rerank(overlap) -> top6 -> prompt -> answer
  src/vectorStore.js      pgvector query: top-12 semantic candidates + MIN_SCORE floor
  src/rerank.js           NEW: ingredient-overlap scoring, isolated from vectorStore
  src/db.js               connection pool + schema (recipes/chunks/collections/app_state)
  src/collections.js      collection registry, recipes, chunks, embedding reuse, versioning
  src/gemini.js           embed() / embedBatch() / generate() -- same REST wrapper, unchanged
  src/middleware.js        admin auth, request id, usage stats -- unchanged
  src/pipeline/
    parse.js              CSV -> rows -> validated recipe records
    chunk.js               recipe -> single text blob
    run.js                 parse -> validate -> chunk -> embed job runner
  src/ingest.js            npm run ingest <file.csv> CLI
  src/adminRoutes.js       upload / jobs / collections / stock routes
  fixtures/
    recipes-50.csv         sample catalog for first ingest
```

## Database schema

Same four tables as the reference, renamed:

- `collections` — unchanged column set (id, name, format, chunk_strategy,
  status, created_at, counts, timings, summary, rejected, duplicates, model,
  dims, error, embeddings_built_at, raw_filename, raw_bytes). `chunk_strategy`
  is always `'single'` now (kept as a column for schema/versioning parity with
  the reference, not because there's a real choice).
- `recipes(collection_id, recipe_id, ord, data jsonb)` — replaces `books`.
- `chunks(collection_id, chunk_id, recipe_id, ord, kind, text, hash, embedding vector)`
  — `kind` is always `'full'`.
- `app_state(id boolean, active_collection_id)` — unchanged.

Embedding-reuse-by-hash (`copyReusableEmbeddings`), collection versioning
(build → ready → activate → prune-superseded), and the chunk/book(recipe)
insert helpers all carry over unmodified in shape.

## Ingestion pipeline

`parse -> validate -> chunk -> embed -> activate`, same never-throw-on-bad-row
contract as the reference (a bad row is rejected and reported, not fatal).

- **parse**: CSV → rows, header aliasing, list-field splitting (as above).
- **validate**: required fields are `title`, `mainIngredients` (i.e. the CSV's
  `main_ingredients` after list-parsing must be non-empty), and `instructions`.
  A row missing any of these is rejected with a reason, the rest still import.
- **chunk**: one blob per recipe —
  ```
  Title: {title}
  Cuisine: {cuisine}
  Diet tags: {dietTags.join(', ') or 'none'}
  Main ingredients: {mainIngredients.join(', ')}
  Optional ingredients: {optionalIngredients.join(', ') or 'none'}
  Time: {timeMinutes} minutes | Servings: {servings}
  Instructions summary: {instructions, truncated to ~200 chars}
  ```
  This is also `toDocument()` — the full-context string pasted into the LLM
  prompt for a retrieved recipe (reference does the same: chunk text and
  prompt context are the same flattened record).
- **embed**: `gemini-embedding-001`, batched, unit-normalized, stored in the
  `chunks.embedding vector` column. Unchanged vectors (same chunk id + same
  text hash) are copied from the live collection instead of re-embedded —
  identical mechanism to `copyReusableEmbeddings` in the reference.

## Query pipeline (the one real divergence)

```
user message
  |
  v
buildSearchQuery()          same heuristic as reference: skip rewrite if no
  |                          history or message is long or ENABLE_QUERY_REWRITE=false
  v
embed(searchQuery, 'RETRIEVAL_QUERY')
  |
  v
vectorStore.retrieve(vector, k=12, filters)     ***12, not 6***
  |    Postgres: DISTINCT ON best chunk per recipe, cosine similarity,
  |    filtered by MIN_SCORE floor, ordered by semantic score desc, LIMIT 12
  v
rerank.byIngredientOverlap(candidates, userIngredients)      ***NEW STEP***
  |    userIngredients = simpleSplit(rawUserMessage)
  |    for each candidate: overlapPct =
  |        |{i in mainIngredients : mentions(userIngredients, i)}| / |mainIngredients|
  |    sort candidates desc by overlapPct (semantic score kept as tiebreak only)
  v
slice(0, 6)                 ***RERANK_TOP_K, final count sent to the prompt***
  |
  v
formatContext() -> system prompt ("recommend ONLY from CATALOG below, never
  |                                invent") -> generate() -> Gemini
  v
{ answer, searchQuery, sources: [{id,title,cuisine,dietTags,timeMinutes,
                                    servings, score: overlapPct,
                                    similarity: semanticScore}] }
```

Key points:
- `MIN_SCORE` (relevance floor) still applies at the 12-candidate retrieval
  step, on the semantic score — an off-topic query ("fix my car") can still
  legitimately return zero candidates before rerank even runs.
- `rerank.js` is a standalone module (not folded into `vectorStore.js`) so the
  "search" endpoint (`/api/search`, retrieval-only debug route) can expose
  both the raw 12-pool and the reranked 6 for inspection.
- `mentions()` (whole-word match) is reused from the reference's keyword-bonus
  logic, applied here as the overlap membership test instead of a bonus.
- Each `sources` entry carries **both** `score` (overlap %, what determined
  the final order) and `similarity` (semantic score, what built the pool) —
  the transparency panel shows both so a user can see why a recipe with lower
  semantic similarity but higher overlap ranked above one with higher
  similarity.

### `/api/search` (debug route)
Returns retrieval only, no Gemini call — same purpose as the reference. Now
returns both stages: `{ pool: [...12 candidates with semantic score...],
reranked: [...top 6 with overlapPct...] }`.

## Admin / catalog versioning (unchanged from reference)

- Every upload is a new `collections` row in `building` status.
- `parse -> validate -> chunk -> embed` job runs in-process, polled via
  `GET /admin/jobs/:id` (same job-registry-with-TTL pattern).
- Publish = `POST /admin/collections/:id/activate` → `swapIndex()` (hot,
  validates loadability) → `setActive()` → `pruneExcept()` (deletes every
  other non-building collection).
- Chunk inspector (`GET /admin/collections/:id/chunks`), stock browser/search
  (`GET /admin/books` → renamed `GET /admin/recipes`), CSV/JSON export
  (`GET /admin/recipes/export`) — all carried over, `books` renamed
  `recipes` throughout routes and functions.
- `ADMIN_TOKEN` gate via `x-admin-token` header, same timing-safe compare.

## Transparency ("why it said what it said")

Same `<details>`/`<summary>` "Retrieved 6 catalog entries" pattern in the chat
UI as the reference, listing each recipe with both `overlapPct` (drove the
order) and `similarity` (semantic score), plus the rewritten search query
when it differs from what the user typed.

## Query-rewrite for follow-ups

Unchanged mechanism from `rag.js`'s `buildSearchQuery()`: a cheap heuristic
(skip on first turn, skip on long/self-contained messages, skippable via
`ENABLE_QUERY_REWRITE=false`) plus one small Gemini call that folds
conversational context ("make it vegetarian instead") into a standalone
search query before embedding. Note: the *rewritten query* feeds the
embedding/vector-search step; ingredient parsing for the **rerank** step
always uses the raw latest user message (rewriting is about search intent,
not about what's literally in the user's pantry).

## Frontend

```
frontend/
  app/page.js              chat page: ingredient textbox, cuisine/dietTags
                             dropdowns, starter prompts (ingredient examples),
                             "Retrieved 6 catalog entries" sources panel
  app/admin/page.js        upload + 4-stage pipeline progress + collections
                             table (publish/delete) + stock browser/export.
                             No chunk-strategy picker (single strategy).
  app/api/chat/route.js         thin proxy -> backend /api/chat
  app/api/catalog/route.js      thin proxy -> backend /api/catalog
  app/api/health/route.js       thin proxy -> backend /api/health
  app/api/admin/[...path]/route.js   catch-all authenticated admin proxy
  app/layout.js             ChefMind title/meta
  app/globals.css           adapted from reference (same structure, new copy)
```

All API keys and the admin token stay server-side; the browser only ever
talks to the Next.js API routes, exactly as in the reference.

## Environment variables

```
GEMINI_API_KEY          # user has one, will paste when asked, step-wise
ADMIN_TOKEN
DATABASE_URL             # postgres://.../cookbot  (new db name)
PORT=4000
CORS_ORIGIN=http://localhost:3100
CHAT_MODEL=gemini-3.6-flash
EMBED_MODEL=gemini-embedding-001
EMBED_DIMS=768
RETRIEVE_K=12             # pool size before rerank (was the final count in reference)
RERANK_TOP_K=6            # NEW: final count sent to the prompt, after rerank
MIN_SCORE=0.58             # relevance floor, re-calibrate against this catalog
ENABLE_QUERY_REWRITE=true
# CHUNK_STRATEGY: dropped -- single strategy only
```

## Testing approach (for the implementation plan)

- Pipeline: unit tests for parse/validate (bad-row handling, header aliasing,
  list splitting), chunk (blob shape), hash-based reuse.
- vectorStore/rerank: unit test the overlap-percentage math and sort order in
  isolation (no DB), integration test against a real pgvector instance for
  the 12-candidate query + floor.
- rag.js: test the rewrite-skip heuristics, the 12→6 pipeline wiring, and the
  "no candidates" (below-floor) path.
- Admin flow: build → activate → prune, and reject-if-active-or-building on
  delete.

## Open items for implementation

None outstanding — all decisions above were confirmed by the user during
brainstorming. Implementation proceeds via `writing-plans`.
