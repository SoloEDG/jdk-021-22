import type {
  Game,
  RecipeId,
  RoundArchive,
} from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import type { ReplayResult } from "./simulator";
import type { TimelineAnalysis, BlockerTag } from "./timeline";
import { blockerLabel } from "./timeline";

export interface LossItem {
  category: "miss" | "waste" | "quality" | "freshness" | "supply";
  time: number;
  orderId: number | null;
  recipe: RecipeId | null;
  amount: number;
  title: string;
  scene: string;
}

export interface LossReport {
  items: LossItem[];
  missTotal: number;
  wasteTotal: number;
  supplyTotal: number;
  qualityGap: number;
  freshnessGap: number;
  totalLoss: number;
}

export function locateLosses(
  archive: RoundArchive,
  timeline: TimelineAnalysis,
  baseline: ReplayResult,
): LossReport {
  const g = baseline.game;
  const items: LossItem[] = [];
  const orderScene = (orderId: number | null): string => {
    if (orderId == null) return "无对应订单";
    const tl = timeline.orders.find((o) => o.orderId === orderId);
    if (!tl) return "无对应订单";
    const top = dominantBlocker(tl);
    const phase = dominantPhase(tl);
    return `该单主要消耗于「${phase}」，最显著阻塞：${top === "none" ? "无（作业/操作节奏）" : blockerLabel(top)}`;
  };

  for (const e of g.entries.filter((x) => x.kind === "miss")) {
    const orderId = matchOrderByLabel(g, e.label);
    const recipe =
      orderId == null
        ? null
        : (g.orders.find((o) => o.id === orderId)?.recipe ?? null);
    items.push({
      category: "miss",
      time: e.time,
      orderId,
      recipe,
      amount: -e.amount,
      title: e.label,
      scene: orderScene(orderId),
    });
  }

  for (const e of g.entries.filter((x) => x.kind === "waste")) {
    items.push({
      category: "waste",
      time: e.time,
      orderId: null,
      recipe: null,
      amount: -e.amount,
      title: e.label,
      scene: "出餐台菜品被丢弃；多为出餐台拥堵或错菜后腾位所致",
    });
  }

  for (const e of g.entries.filter((x) => x.kind === "supply")) {
    items.push({
      category: "supply",
      time: e.time,
      orderId: null,
      recipe: null,
      amount: -e.amount,
      title: e.label,
      scene: "采购补货支出，计入成本而非异常损失",
    });
  }

  let qualityGap = 0;
  let freshnessGap = 0;
  for (const s of baseline.servedEvents) {
    const ideal = recipes[s.recipe].price;
    const qGap = ideal - Math.round((ideal * s.cookQuality) / 100);
    const fGap =
      Math.round((ideal * s.cookQuality) / 100) -
      Math.round((ideal * s.servedQuality) / 100);
    if (qGap > 0) {
      qualityGap += qGap;
      items.push({
        category: "quality",
        time: s.time,
        orderId: s.orderId,
        recipe: s.recipe,
        amount: qGap,
        title: `#${String(s.orderId).padStart(3, "0")} 火候折损（起锅品质 ${s.cookQuality}）`,
        scene: `起锅火候偏离目标，按品质折算少收 ¥${qGap}`,
      });
    }
    if (fGap > 0) {
      freshnessGap += fGap;
      items.push({
        category: "freshness",
        time: s.time,
        orderId: s.orderId,
        recipe: s.recipe,
        amount: fGap,
        title: `#${String(s.orderId).padStart(3, "0")} 失温折损（上桌品质 ${s.servedQuality}）`,
        scene: `起锅超过15秒未上菜导致失温，少收 ¥${fGap}；${orderScene(s.orderId)}`,
      });
    }
  }

  const missTotal = sum(items, "miss");
  const wasteTotal = sum(items, "waste");
  const supplyTotal = sum(items, "supply");
  const totalLoss = missTotal + wasteTotal + qualityGap + freshnessGap;
  return {
    items: items.sort((a, b) => a.time - b.time),
    missTotal,
    wasteTotal,
    supplyTotal,
    qualityGap,
    freshnessGap,
    totalLoss,
  };
}

function sum(items: LossItem[], cat: LossItem["category"]): number {
  return items
    .filter((i) => i.category === cat)
    .reduce((s, i) => s + i.amount, 0);
}

function dominantBlocker(tl: TimelineAnalysis["orders"][number]): BlockerTag {
  let best: BlockerTag = "none";
  let bestV = 0;
  for (const [k, v] of Object.entries(tl.blocked) as [BlockerTag, number][]) {
    if (k === "none") continue;
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  return best;
}

function dominantPhase(tl: TimelineAnalysis["orders"][number]): string {
  const labels: [keyof typeof tl.totals, string][] = [
    ["intake", "待接单"],
    ["prep", "缺料/备料等待"],
    ["stove", "等锅"],
    ["cook", "烹饪"],
    ["serve", "等上菜"],
  ];
  let best = labels[0];
  for (const l of labels) if (tl.totals[l[0]] > tl.totals[best[0]]) best = l;
  return best[1];
}

function matchOrderByLabel(g: Game, label: string): number | null {
  const guest = label.replace(" 等待超时", "");
  return g.orders.find((x) => x.guest === guest)?.id ?? null;
}
