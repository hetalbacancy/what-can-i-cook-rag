/**
 * Stage 1 + 2 of the pipeline: parse an uploaded file into rows, then normalise
 * and validate those rows into recipe records.
 *
 * The hard rule here is that this module NEVER throws on bad data. A catalog of
 * 500 rows with 3 broken ones should import 497 recipes and report 3 problems --
 * not abort the whole upload. Only a file we cannot read at all is fatal.
 */

/** Fields that hold a list. In CSV these arrive as "a; b; c" (or comma-separated). */
const LIST_FIELDS = ['dietTags', 'mainIngredients', 'optionalIngredients'];
const NUMBER_FIELDS = ['timeMinutes', 'servings'];

/** Accept camelCase, snake_case, kebab-case and spaced CSV headers alike. */
const HEADER_ALIASES = {
  diet_tags: 'dietTags',
  'diet tags': 'dietTags',
  diettags: 'dietTags',
  diet: 'dietTags',
  main_ingredients: 'mainIngredients',
  'main ingredients': 'mainIngredients',
  mainingredients: 'mainIngredients',
  ingredients: 'mainIngredients',
  optional_ingredients: 'optionalIngredients',
  'optional ingredients': 'optionalIngredients',
  optionalingredients: 'optionalIngredients',
  time_minutes: 'timeMinutes',
  'time minutes': 'timeMinutes',
  timeminutes: 'timeMinutes',
  time: 'timeMinutes',
  cook_time: 'timeMinutes',
  prep_time: 'timeMinutes',
};

function canonicalKey(raw) {
  const key = String(raw).trim();
  const lower = key.toLowerCase();
  return HEADER_ALIASES[lower] ?? key;
}

// ------------------------------------------------------------------- CSV

/**
 * RFC4180-ish CSV reader: handles quoted fields, commas and newlines inside
 * quotes, "" as an escaped quote, and both \n and \r\n line endings.
 * Hand-rolled to keep the dependency list at three packages.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Trailing field / row, unless the file ended on a clean newline.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (!nonEmpty.length) return [];

  const headers = nonEmpty[0].map(canonicalKey);
  return nonEmpty.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? '';
    });
    return obj;
  });
}

function parseJson(text) {
  const data = JSON.parse(text);
  const rows = Array.isArray(data) ? data : (data.recipes ?? data.items ?? data.data);
  if (!Array.isArray(rows)) {
    throw new Error('JSON must be an array of recipes, or an object with a "recipes" array');
  }
  return rows.map((row) => {
    const obj = {};
    for (const [k, v] of Object.entries(row ?? {})) obj[canonicalKey(k)] = v;
    return obj;
  });
}

// ------------------------------------------------------- normalise + validate

function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value == null) return [];
  // Semicolons first so "chicken, thigh" in a quoted CSV cell still splits.
  const raw = String(value);
  const parts = raw.includes(';') ? raw.split(';') : raw.split(',');
  return parts.map((v) => v.trim()).filter(Boolean);
}

function toNumber(value) {
  if (value === '' || value == null) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ identity

/** Lowercase, punctuation-free, single-dashed. Used to build a stable fallback id. */
function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The keys a recipe is deduplicated on, most specific first.
 *
 * A row's own `id` is authoritative when present. Failing that, the same
 * title in the same cuisine IS the same recipe, however the columns are
 * capitalised -- which is what catches the copy-pasted row in a
 * hand-maintained spreadsheet.
 */
function recipeKeys(recipe) {
  const keys = [];
  if (recipe.id) keys.push(`id:${String(recipe.id).trim().toLowerCase()}`);
  const tc = `${slug(recipe.title)}|${slug(recipe.cuisine)}`;
  if (tc !== '|') keys.push(`tc:${tc}`);
  return keys;
}

/**
 * Normalise one raw row into a recipe record.
 * @returns {{ recipe: object } | { reason: string }}
 */
function normalizeRow(row) {
  const get = (k) => (typeof row[k] === 'string' ? row[k].trim() : row[k]);

  const title = get('title');
  const instructions = get('instructions');
  const mainIngredients = toList(row.mainIngredients);

  const missing = [];
  if (!title) missing.push('title');
  if (!mainIngredients.length) missing.push('main_ingredients');
  if (!instructions) missing.push('instructions');
  if (missing.length) return { reason: `missing required field(s): ${missing.join(', ')}` };

  const recipe = {
    // A derived id is deterministic, so a recipe keeps the same id across
    // re-uploads of the catalog. A row counter would renumber every recipe
    // the moment a row was inserted above it, invalidating every cached
    // vector.
    id: String(get('id') || '').trim() || slug(`${title}-${get('cuisine') || 'recipe'}`) || 'recipe',
    title: String(title),
    cuisine: String(get('cuisine') ?? '').trim() || 'unspecified',
    mainIngredients,
    instructions: String(instructions),
  };

  for (const f of LIST_FIELDS) if (f !== 'mainIngredients') recipe[f] = toList(row[f]);
  for (const f of NUMBER_FIELDS) recipe[f] = toNumber(row[f]);

  return { recipe };
}

/**
 * Parse a whole upload.
 *
 * Duplicates WITHIN the file collapse to one recipe, last row winning, and are
 * reported rather than silently kept. The previous behaviour suffixed a
 * repeated id (`r001` -> `r001_7`), which quietly turned a copy-paste mistake
 * into two catalog entries for the same recipe.
 *
 * @param {string} text     raw file contents
 * @param {'csv'|'json'} format
 * @returns {{ recipes: object[], rejected: {row:number, reason:string}[],
 *             duplicates: {row:number, title:string, reason:string}[], rowCount:number }}
 */
export function parseCatalog(text, format) {
  const rows = format === 'csv' ? parseCsv(text) : parseJson(text);

  const recipes = [];
  const rejected = [];
  const duplicates = [];
  const seen = new Map(); // key -> index into recipes

  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    let result;
    try {
      result = normalizeRow(row);
    } catch (err) {
      result = { reason: `could not read row (${err.message})` };
    }
    if (!result.recipe) {
      rejected.push({ row: rowNumber, reason: result.reason });
      return;
    }

    const keys = recipeKeys(result.recipe);
    const hit = keys.map((k) => seen.get(k)).find((v) => v !== undefined);

    if (hit !== undefined) {
      const previous = recipes[hit];
      duplicates.push({
        row: rowNumber,
        title: result.recipe.title,
        reason: `duplicate of "${previous.title}" (${previous.cuisine}) -- kept this later row`,
      });
      // Keep the earlier recipe's id so any existing reference to it still resolves.
      recipes[hit] = { ...result.recipe, id: previous.id };
      for (const k of recipeKeys(recipes[hit])) seen.set(k, hit);
      return;
    }

    const index = recipes.push(result.recipe) - 1;
    for (const k of keys) seen.set(k, index);
  });

  return { recipes, rejected, duplicates, rowCount: rows.length };
}
