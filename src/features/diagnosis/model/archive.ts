import type {
  Game,
  Ingredient,
  RecipeId,
  RoundArchive,
  RoundConfig,
} from "../../../shared/types";
import { recipes as catalog } from "../../../shared/catalog";
import { grade, totals } from "../../ledger/lib/totals";

const ARCHIVE_KEY = "lunch-rush-archives-v1";
const MAX_ARCHIVES = 12;

export function buildConfig(g: Game): RoundConfig {
  return {
    duration: g.duration,
    prepCap: g.prepCap,
    dishCap: g.dishCap,
    stockCap: g.stockCap,
    initialStock: { ...g.initialStock },
    stoves: g.stoves.map((s) => ({ id: s.id, kind: s.kind })),
    recipes: (Object.keys(catalog) as RecipeId[]).map((id) => {
      const r = catalog[id];
      return {
        id: r.id,
        name: r.name,
        ingredient: r.ingredient,
        station: r.station,
        target: r.target,
        price: r.price,
      };
    }),
    arrivals: [
      ...g.orders
        .filter((o) => o.arrived === 0)
        .map((o) => ({
          id: o.id,
          recipe: o.recipe,
          guest: o.guest,
          arrived: o.arrived,
          deadline: o.deadline,
        })),
      ...g.arrivalPlan,
    ].sort((a, b) => a.arrived - b.arrived || a.id - b.id),
  };
}

export function configKey(cfg: RoundConfig): string {
  return cfg.recipes
    .map(
      (r) =>
        `${r.id}:${r.ingredient}:${r.station}:${r.target}:${r.price}`,
    )
    .join("|");
}

export function flowKey(cfg: RoundConfig): string {
  return cfg.arrivals
    .map((a) => `${a.id}@${a.arrived}:${a.recipe}:${a.deadline}`)
    .join("|");
}

/** 在 closeShift 清理灶台/菜品之前调用，保留完整流水与账本快照。 */
export function archiveRound(g: Game): RoundArchive {
  const config = buildConfig(g);
  const t = totals(g);
  const archive: RoundArchive = {
    id: `round-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    endedAt: Date.now(),
    config,
    configKey: configKey(config),
    flowKey: flowKey(config),
    transcript: g.transcript.map((e) => ({ ...e, command: { ...e.command } })),
    ledger: g.entries.map((e) => ({ ...e })),
    net: t.net,
    sales: t.sales,
    cost: t.cost,
    served: g.served,
    missed: g.missed,
    grade: grade(g),
  };
  return archive;
}

export function loadArchives(): RoundArchive[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RoundArchive[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveArchive(archive: RoundArchive): RoundArchive[] {
  const list = loadArchives();
  list.push(archive);
  const trimmed = list.slice(-MAX_ARCHIVES);
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(trimmed));
  } catch {
    // 存储不可用时仅返回内存结果，不影响本局结算与历史最佳
  }
  return trimmed;
}

export function isComparable(a: RoundArchive, b: RoundArchive): boolean {
  return a.configKey === b.configKey && a.flowKey === b.flowKey;
}

export function comparableReason(a: RoundArchive, b: RoundArchive): string {
  const sameConfig = a.configKey === b.configKey;
  const sameFlow = a.flowKey === b.flowKey;
  if (sameConfig && sameFlow) return "两局菜谱（含价格）与来客表完全一致，可直接对比";
  if (!sameConfig && !sameFlow)
    return "两局菜谱与客流均不同，差异不可直接归因";
  if (!sameConfig)
    return "两局菜谱/价格不同，即使客流一致也不可直接归因";
  return "两局来客表不同（客流差异），净收益差异不可直接归因于操作或资源";
}

export function findComparable(
  target: RoundArchive,
  all: RoundArchive[],
): RoundArchive | null {
  const earlier = all.filter(
    (a) => a.id !== target.id && isComparable(a, target),
  );
  return earlier[earlier.length - 1] ?? null;
}

export function ingredientList(): Ingredient[] {
  return ["beef", "noodle", "greens"];
}
