/**
 * Stage 3: turn recipe records into the text unit we embed.
 *
 * Single strategy only -- one blob per recipe, combining title, cuisine, diet
 * tags, ingredients and a short instructions summary. An embedding can only
 * match on text it was shown, so whatever a cook might type ("chicken,
 * garlic, rice") has to appear in that blob in some recognisable form.
 *
 * The same blob is also what gets pasted into the LLM prompt for a retrieved
 * recipe (toDocument()) -- chunk text and prompt context are the same
 * flattened record, same as the reference project.
 */

const list = (v) => (Array.isArray(v) && v.length ? v.join(', ') : 'none');
const num = (v) => (v == null || v === '' ? 'unknown' : String(v));

/** Keep the blob focused on what a cook would search by, not the full method. */
const INSTRUCTIONS_SUMMARY_LEN = 200;

function summarize(instructions) {
  const text = String(instructions ?? '').trim();
  if (text.length <= INSTRUCTIONS_SUMMARY_LEN) return text;
  return `${text.slice(0, INSTRUCTIONS_SUMMARY_LEN).trimEnd()}...`;
}

/** The flattened record -- what gets embedded, and what gets pasted into the LLM prompt. */
export function toDocument(recipe) {
  return [
    `Title: ${recipe.title}`,
    `Cuisine: ${recipe.cuisine}`,
    `Diet tags: ${list(recipe.dietTags)}`,
    `Main ingredients: ${list(recipe.mainIngredients)}`,
    `Optional ingredients: ${list(recipe.optionalIngredients)}`,
    `Time: ${num(recipe.timeMinutes)} minutes | Servings: ${num(recipe.servings)}`,
    `Instructions summary: ${summarize(recipe.instructions)}`,
  ].join('\n');
}

export const STRATEGIES = ['single'];
export const DEFAULT_STRATEGY = 'single';

/**
 * @param {object[]} recipes
 * @returns {{chunkId:string, recipeId:string, kind:string, text:string}[]}
 */
export function chunkRecipes(recipes) {
  return recipes.map((recipe) => ({
    chunkId: `${recipe.id}#full`,
    recipeId: recipe.id,
    kind: 'full',
    text: toDocument(recipe),
  }));
}
