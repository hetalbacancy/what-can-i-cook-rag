# 🍳 ChefMind — a small RAG project

A recipe-recommendation chatbot that can only recommend recipes from a
catalog **you upload**. If a recipe isn't in the catalog, the bot won't
invent it.

Next.js (frontend) · Express (backend) · Postgres + pgvector (catalog &
search) · Google Gemini (AI)

Architecture mirrors the reference book-bot project, with one difference:
the query pipeline retrieves a pool of 12 candidates by vector search, then
re-ranks them by ingredient overlap before the top 6 go to the prompt. See
`docs/superpowers/specs/2026-09-14-recipe-rag-design.md` for the full design.

---

## Two pages

| Page | Who | What |
|---|---|---|
| `/` | home cook | Chat — type your ingredients, get recipes |
| `/admin` | catalog owner | Upload a catalog and watch it get processed |

---

## Status

Scaffolding only — folder structure matches the reference project, pipeline
and RAG logic not yet implemented. Being built step by step; see the design
spec for what's coming.

## Setup (once logic is implemented)

### 1. Postgres with pgvector

```bash
sudo apt install -y postgresql postgresql-contrib postgresql-16-pgvector
sudo systemctl enable --now postgresql

sudo -u postgres psql -c "CREATE ROLE bacancy LOGIN CREATEDB PASSWORD 'devpass';"
sudo -u postgres createdb -O bacancy cookbot
sudo -u postgres psql -d cookbot -c "CREATE EXTENSION vector;"
```

### 2. The apps

```bash
cd backend
cp .env.example .env      # paste a Gemini key, set ADMIN_TOKEN, point DATABASE_URL
npm install

cd ../frontend
cp .env.local.example .env.local
npm install
```

### 3. Run (two terminals)

```bash
cd backend  && npm run dev     # http://localhost:4000
cd frontend && npm run dev     # http://localhost:3100
```

Catalog CSV columns: `title, cuisine, diet_tags, main_ingredients,
optional_ingredients, time_minutes, servings, instructions`.

---

## Where things live

```
backend/
  src/server.js          the API routes
  src/rag.js              the RAG flow: rewrite -> retrieve(12) -> rerank(overlap) -> top6 -> answer
  src/vectorStore.js      the semantic search: pgvector query + relevance floor
  src/rerank.js           ingredient-overlap re-ranking (the divergence from the reference)
  src/db.js                connection pool and table definitions
  src/collections.js       catalog versioning (collections, recipes, chunks)
  src/gemini.js            the two AI calls (embed text / write answer)
  src/pipeline/            parse -> validate -> chunk -> embed
  src/ingest.js             the `npm run ingest` command
  fixtures/                 sample catalogs to upload

frontend/
  app/page.js               the chat page
  app/admin/page.js         the upload + pipeline page
  app/api/                  thin proxies, so the browser never sees your keys
```
