import { getDb } from '../db/connection.js';
import type { Recipe, RecipeIngredient, RecipeWithIngredients, Item, ItemType } from '../types/index.js';

export function getAllRecipes(): RecipeWithIngredients[] {
  const db = getDb();
  const recipes = db.prepare('SELECT * FROM recipes ORDER BY name').all() as Recipe[];
  return recipes.map(recipe => ({
    ...recipe,
    ingredients: getRecipeIngredients(recipe.id),
  }));
}

export function getRecipeByName(name: string): RecipeWithIngredients | null {
  const db = getDb();
  const recipe = db.prepare(
    'SELECT * FROM recipes WHERE LOWER(name) = LOWER(?)'
  ).get(name) as Recipe | undefined;
  if (!recipe) return null;
  return {
    ...recipe,
    ingredients: getRecipeIngredients(recipe.id),
  };
}

export function getRecipeIngredients(recipeId: number): RecipeIngredient[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM recipe_ingredients WHERE recipe_id = ?'
  ).all(recipeId) as RecipeIngredient[];
}

export function getRecipesByCategory(category: string): RecipeWithIngredients[] {
  const db = getDb();
  const recipes = db.prepare(
    'SELECT * FROM recipes WHERE LOWER(result_item_type) = LOWER(?) ORDER BY name'
  ).all(category) as Recipe[];
  return recipes.map(recipe => ({
    ...recipe,
    ingredients: getRecipeIngredients(recipe.id),
  }));
}

interface IngredientCheck {
  readonly satisfied: boolean;
  readonly missing: ReadonlyArray<{ readonly item_name: string; readonly needed: number; readonly have: number }>;
}

export function checkPlayerHasIngredients(playerId: number, recipeId: number): IngredientCheck {
  const db = getDb();
  const ingredients = getRecipeIngredients(recipeId);
  const missing: Array<{ item_name: string; needed: number; have: number }> = [];

  for (const ingredient of ingredients) {
    const count = db.prepare(
      'SELECT COUNT(*) as cnt FROM items WHERE owner_id = ? AND LOWER(name) = LOWER(?)'
    ).get(playerId, ingredient.item_name) as { cnt: number };

    if (count.cnt < ingredient.quantity) {
      missing.push({
        item_name: ingredient.item_name,
        needed: ingredient.quantity,
        have: count.cnt,
      });
    }
  }

  return { satisfied: missing.length === 0, missing };
}

export function craftItem(playerId: number, recipeId: number): Item {
  const db = getDb();
  const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId) as Recipe;
  const ingredients = getRecipeIngredients(recipeId);

  const craft = db.transaction(() => {
    // Consume ingredients: for each ingredient, delete the required quantity of matching items
    for (const ingredient of ingredients) {
      const playerItems = db.prepare(
        'SELECT id FROM items WHERE owner_id = ? AND LOWER(name) = LOWER(?) LIMIT ?'
      ).all(playerId, ingredient.item_name, ingredient.quantity) as Array<{ id: number }>;

      if (playerItems.length < ingredient.quantity) {
        throw new Error(`Not enough ${ingredient.item_name}. Need ${ingredient.quantity}, have ${playerItems.length}.`);
      }

      for (const item of playerItems) {
        db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
      }
    }

    // Create the result item with rarity and level requirement
    const result = db.prepare(`
      INSERT INTO items (name, description, item_type, damage_bonus, defense_bonus, heal_amount, value, owner_id, rarity, level_requirement)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recipe.result_item_name,
      recipe.result_description,
      recipe.result_item_type,
      recipe.result_damage_bonus,
      recipe.result_defense_bonus,
      recipe.result_heal_amount,
      recipe.result_value,
      playerId,
      recipe.result_rarity,
      recipe.result_level_requirement
    );

    return db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid) as Item;
  });

  return craft();
}
