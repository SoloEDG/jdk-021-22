import type { Game, RecipeId, Ingredient } from "../../../shared/types";
import { recipes, ingredients } from "../../../shared/catalog";
import { preparationIssue, restockIssue } from "../lib/availability";
export function prepare(g: Game, r: RecipeId) {
  const issue = preparationIssue(g, r);
  if (issue) {
    g.notice = issue;
    return;
  }
  g.stock[recipes[r].ingredient]--;
  g.portions.push({ id: g.nextId++, recipe: r, preparedAt: g.time });
  g.notice = `${recipes[r].name} 备料完成，可送入灶台`;
}
export function restock(g: Game, i: Ingredient) {
  const issue = restockIssue(g, i);
  if (issue) {
    g.notice = issue;
    return;
  }
  g.stock[i] = Math.min(g.stockCap, g.stock[i] + 3);
  g.entries.push({
    id: g.nextId++,
    time: g.time,
    label: `采购${ingredients[i].name} ×3`,
    amount: -ingredients[i].cost * 3,
    kind: "supply",
  });
  g.notice = "已购入3份食材，费用计入账本";
}
