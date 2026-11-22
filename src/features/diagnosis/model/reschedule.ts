import type {
  Game,
  Ingredient,
  RecipeId,
  RoundArchive,
} from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { createGame } from "../../../shared/initial";
import { accept, expire } from "../../orders/model/orders";
import { prepare, restock } from "../../pantry/model/inventory";
import { cook, lift } from "../../kitchen/model/cooking";
import { plate, discard } from "../../service/model/plating";
import { deliver } from "../../service/model/delivery";
import { preparationIssue } from "../../pantry/lib/availability";
import { servingQuality } from "../../service/lib/freshness";

export interface RescheduleReport {
  net: number;
  served: number;
  missed: number;
  sales: number;
  cost: number;
  baselineNet: number;
  potential: number;
  note: string;
  decisions: number;
}

const TICK = 0.1;
function round1(t: number): number {
  return Math.round(t * 10) / 10;
}

/**
 * 重新调度潜力：保持原局客流、菜谱与资源完全不变，仅替换玩家决策。
 * 该结果独立于“单项资源改进”，其收益不得并入任何单项改进的数字。
 */
export function reschedule(archive: RoundArchive): RescheduleReport {
  const g = createGame(0);
  const cfg = archive.config;
  g.duration = cfg.duration;
  g.prepCap = cfg.prepCap;
  g.dishCap = cfg.dishCap;
  g.stockCap = cfg.stockCap;
  g.stock = { ...cfg.initialStock };
  g.stoves = cfg.stoves.map((s) => ({ ...s, portion: null, started: 0 }));
  g.orders = cfg.arrivals
    .filter((a) => a.arrived === 0)
    .map((a) => ({ ...a, status: "waiting" as const }));
  // 与现场/重演保持同一动态 id 起点（来客计划止于 11）
  g.nextId = 12;
  g.running = true;

  let decisions = 0;
  const inject = () => {
    if (
      g.orders.filter(
        (o) => o.status === "waiting" || o.status === "accepted",
      ).length >= 6
    ) {
      return;
    }
    for (const a of cfg.arrivals.filter((x) => x.arrived > 0)) {
      if (round1(a.arrived) === round1(g.time)) {
        g.orders.push({ ...a, status: "waiting" });
      }
    }
  };

  const step = () => {
    inject();
    acceptAll(g, () => decisions++);
    cookReady(g, () => decisions++);
    liftReady(g, () => decisions++);
    plateAll(g, () => decisions++);
    serveBest(g, () => decisions++);
    prepNext(g, () => decisions++);
    restockNeeded(g, () => decisions++);
  };

  while (g.time < g.duration) {
    step();
    g.time = round1(g.time + TICK);
    expire(g);
    if (g.time >= g.duration) {
      inject();
      // 打烊同刻仍可交付，与现场规则一致
      serveBest(g, () => decisions++);
      g.running = false;
      g.ended = true;
    }
  }

  const net = g.entries.reduce((s, e) => s + e.amount, 0);
  const sales = g.entries
    .filter((e) => e.kind === "sale")
    .reduce((s, e) => s + e.amount, 0);
  const cost = -g.entries
    .filter((e) => e.amount < 0)
    .reduce((s, e) => s + e.amount, 0);
  const baselineNet = archive.net;
  return {
    net,
    served: g.served,
    missed: g.missed,
    sales,
    cost,
    baselineNet,
    potential: net - baselineNet,
    note: "基于启发式自动调度（最早截止优先 + 到点即起锅 + 立即装盘上菜），代表不改资源只改排程的潜力，非全局最优解",
    decisions,
  };
}

function acceptAll(g: Game, mark: () => void) {
  for (const o of g.orders.filter((x) => x.status === "waiting")) {
    accept(g, o.id);
    mark();
  }
}

function urgency(o: { deadline: number; arrived: number }) {
  return o.deadline;
}

function prepNext(g: Game, mark: () => void) {
  const accepted = g.orders
    .filter((o) => o.status === "accepted")
    .sort((a, b) => urgency(a) - urgency(b) || a.id - b.id);
  for (const o of accepted) {
    if (hasWorkInProgress(g, o.recipe)) continue;
    if (preparationIssue(g, o.recipe)) continue;
    prepare(g, o.recipe);
    mark();
    return;
  }
}

function hasWorkInProgress(g: Game, recipe: RecipeId): boolean {
  if (g.portions.some((p) => p.recipe === recipe)) return true;
  if (g.stoves.some((s) => s.portion?.recipe === recipe)) return true;
  if (g.dishes.some((d) => d.recipe === recipe)) return true;
  return false;
}

function cookReady(g: Game, mark: () => void) {
  for (const s of g.stoves) {
    if (s.portion) continue;
    const candidate = g.portions
      .filter((p) => recipes[p.recipe].station === s.kind)
      .sort((a, b) => {
        const oa = g.orders.find(
          (o) => o.status === "accepted" && o.recipe === a.recipe,
        );
        const ob = g.orders.find(
          (o) => o.status === "accepted" && o.recipe === b.recipe,
        );
        return (oa?.deadline ?? 999) - (ob?.deadline ?? 999);
      })[0];
    if (candidate) {
      cook(g, candidate.id, s.id);
      mark();
    }
  }
}

function liftReady(g: Game, mark: () => void) {
  for (const s of g.stoves) {
    if (!s.portion) continue;
    if (g.dishes.length >= g.dishCap) continue;
    const elapsed = g.time - s.started;
    const target = recipes[s.portion.recipe].target;
    // 到最佳火候即起锅；若订单即将超时则提前起锅保交付
    const urgentOrder = g.orders.find(
      (o) =>
        o.status === "accepted" &&
        o.recipe === s.portion!.recipe &&
        o.deadline - g.time <= target - elapsed + 1,
    );
    if (elapsed >= target || (urgentOrder && elapsed >= target - 2)) {
      lift(g, s.id);
      mark();
    }
  }
}

function plateAll(g: Game, mark: () => void) {
  for (const d of g.dishes.filter((x) => x.stage === "counter")) {
    plate(g, d.id);
    mark();
  }
}

function serveBest(g: Game, mark: () => void) {
  const plated = g.dishes.filter((d) => d.stage === "plated");
  for (const dish of plated) {
    if (servingQuality(g, dish) < 30) {
      // 必被拒收的菜品直接丢弃，避免占台；浪费成本照常记账
      discard(g, dish.id);
      mark();
      continue;
    }
    const target = g.orders
      .filter((o) => o.status === "accepted" && o.recipe === dish.recipe)
      .sort((a, b) => a.deadline - b.deadline || a.id - b.id)[0];
    if (!target) continue;
    g.selectedDish = dish.id;
    g.selectedOrder = target.id;
    deliver(g);
    mark();
    expire(g);
  }
  g.selectedDish = null;
  g.selectedOrder = null;
}

function restockNeeded(g: Game, mark: () => void) {
  const need: Ingredient[] = ["beef", "noodle", "greens"];
  for (const ing of need) {
    const futureDemand = g.orders.filter(
      (o) =>
        o.status === "accepted" &&
        recipes[o.recipe].ingredient === ing,
    ).length;
    const inProcess =
      g.portions.filter((p) => recipes[p.recipe].ingredient === ing).length +
      g.stoves.filter((s) => s.portion && recipes[s.portion.recipe].ingredient === ing)
        .length +
      g.dishes.filter((d) => recipes[d.recipe].ingredient === ing).length;
    if (g.stock[ing] + inProcess < Math.max(1, futureDemand) && g.stock[ing] < g.stockCap) {
      restock(g, ing);
      mark();
      return;
    }
  }
}
