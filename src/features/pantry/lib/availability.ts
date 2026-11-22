import type { Game, RecipeId } from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
export function preparationIssue(g: Game, r: RecipeId): string {
  if (g.portions.length >= g.prepCap)
    return `备料台已满（${g.prepCap}份）`;
  if (g.stock[recipes[r].ingredient] < 1) return "食材不足，请采购";
  return "";
}
export function restockIssue(g: Game, i: keyof typeof g.stock): string {
  if (g.stock[i] >= g.stockCap) return `库存充足，上限${g.stockCap}份`;
  return "";
}
