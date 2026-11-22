import type {
  Game,
  RecipeId,
  RoundArchive,
  TranscriptEntry,
} from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { replay, type ReplayResult, type ResourceOverride } from "./simulator";

export interface SkippedCommand {
  time: number;
  command: TranscriptEntry["command"];
  reason: string;
  /** 该指令在原局现场是否曾成功执行（用于区分“资源变化导致的失效”与“现场本就被拒”） */
  liveApplied: boolean;
}

export interface OrderImpact {
  orderId: number;
  recipe: RecipeId;
  baselineOutcome: "served" | "left";
  variantOutcome: "served" | "left";
  baselineIncome: number;
  variantIncome: number;
  delta: number;
  crowding: boolean;
  note: string;
}

export interface ImprovementReport {
  id: string;
  title: string;
  description: string;
  override: ResourceOverride;
  baselineNet: number;
  variantNet: number;
  netDelta: number;
  baselineServed: number;
  variantServed: number;
  baselineMissed: number;
  variantMissed: number;
  skipped: SkippedCommand[];
  orderImpacts: OrderImpact[];
  crowdingLoss: number;
  crowdingNotes: string[];
  reconciliation: string[];
}

function netOf(g: Game): number {
  return g.entries.reduce((s, e) => s + e.amount, 0);
}

function salesByOrder(result: ReplayResult): Map<number, number> {
  const map = new Map<number, number>();
  for (const ev of result.servedEvents) map.set(ev.orderId, ev.amount);
  return map;
}

function describeCommand(c: TranscriptEntry["command"]): string {
  switch (c.type) {
    case "accept":
      return `接单 #${c.id}`;
    case "select-order":
      return `选择订单 #${c.id}`;
    case "prepare":
      return `备料「${recipes[c.recipe].name}」`;
    case "restock":
      return `采购补货`;
    case "cook":
      return `备料 #${c.portion} 下灶 #${c.stove}`;
    case "lift":
      return `灶 #${c.id} 起锅`;
    case "plate":
      return `菜品 #${c.id} 装盘`;
    case "select-dish":
      return `选择菜品 #${c.id}`;
    case "serve":
      return `上菜`;
    case "discard":
      return `丢弃菜品 #${c.id}`;
  }
}

function buildImpacts(
  archive: RoundArchive,
  base: ReplayResult,
  variant: ReplayResult,
): OrderImpact[] {
  const baseSales = salesByOrder(base);
  const varSales = salesByOrder(variant);
  return variant.game.orders.map((vo) => {
    const bo = base.game.orders.find((o) => o.id === vo.id);
    const baselineOutcome =
      bo?.status === "served" ? ("served" as const) : ("left" as const);
    const variantOutcome =
      vo.status === "served" ? ("served" as const) : ("left" as const);
    const baselineIncome = baseSales.get(vo.id) ?? 0;
    const variantIncome = varSales.get(vo.id) ?? 0;
    const delta = variantIncome - baselineIncome;
    const crowding = baselineOutcome === "served" && variantOutcome === "left";
    let note = "";
    if (crowding) {
      note = "原可成交，在改进方案中被挤占离店";
    } else if (baselineOutcome === "left" && variantOutcome === "served") {
      note = "改进方案救回的订单";
    } else if (delta !== 0) {
      note = `成交金额变化 ¥${delta}`;
    } else {
      note = "无变化";
    }
    return {
      orderId: vo.id,
      recipe: vo.recipe,
      baselineOutcome,
      variantOutcome,
      baselineIncome,
      variantIncome,
      delta,
      crowding,
      note,
    };
  });
}

function evaluate(
  archive: RoundArchive,
  id: string,
  title: string,
  description: string,
  override: ResourceOverride,
  baseline: ReplayResult,
): ImprovementReport {
  const variant = replay(archive, override);
  const skipped: SkippedCommand[] = variant.commands
    .filter((c) => !c.applied)
    .map((c) => ({
      time: c.time,
      command: c.entry.command,
      reason: c.reason,
      liveApplied: c.entry.outcome === "applied",
    }));

  const orderImpacts = buildImpacts(archive, baseline, variant);
  const crowdingImpacts = orderImpacts.filter((i) => i.crowding);
  const crowdingLoss = crowdingImpacts.reduce(
    (s, i) => s + Math.max(0, i.baselineIncome),
    0,
  );
  const crowdingNotes = crowdingImpacts.map(
    (i) =>
      `#${String(i.orderId).padStart(3, "0")}「${recipes[i.recipe].name}」被挤占：原收入 ¥${i.baselineIncome} 流失`,
  );

  const baselineNet = netOf(baseline.game);
  const variantNet = netOf(variant.game);
  const netDelta = variantNet - baselineNet;

  // 逐单 delta 之和必须等于总账 delta（含 miss/waste/supply 也应配平）
  const orderDeltaSum = orderImpacts.reduce((s, i) => s + i.delta, 0);
  const nonSaleDelta =
    nonSaleNet(variant.game) - nonSaleNet(baseline.game);
  const reconciliation: string[] = [];
  const computed = orderDeltaSum + nonSaleDelta;
  if (computed !== netDelta) {
    reconciliation.push(
      `对账偏差 ¥${netDelta - computed}：逐单成交差 ${orderDeltaSum} + 非销售账差 ${nonSaleDelta} ≠ 总账差 ${netDelta}`,
    );
  } else {
    reconciliation.push(
      `对账配平：逐单成交差 ¥${orderDeltaSum} + 采购/赔付/浪费差 ¥${nonSaleDelta} = 总账差 ¥${netDelta}`,
    );
  }

  return {
    id,
    title,
    description,
    override,
    baselineNet,
    variantNet,
    netDelta,
    baselineServed: baseline.game.served,
    variantServed: variant.game.served,
    baselineMissed: baseline.game.missed,
    variantMissed: variant.game.missed,
    skipped,
    orderImpacts,
    crowdingLoss,
    crowdingNotes,
    reconciliation,
  };
}

function nonSaleNet(g: Game): number {
  return g.entries
    .filter((e) => e.kind !== "sale")
    .reduce((s, e) => s + e.amount, 0);
}

export function evaluateImprovements(archive: RoundArchive): ImprovementReport[] {
  const baseline = replay(archive);
  const panCount = archive.config.stoves.filter((s) => s.kind === "pan").length;
  const potCount = archive.config.stoves.filter((s) => s.kind === "pot").length;
  const maxStoveId = Math.max(...archive.config.stoves.map((s) => s.id));

  const candidates: {
    id: string;
    title: string;
    description: string;
    override: ResourceOverride;
  }[] = [
    {
      id: "extra-pan",
      title: "增设一口煎锅",
      description: `煎锅 ${panCount} → ${panCount + 1}，汤锅保持 ${potCount} 口；缓解牛排/沙拉抢锅`,
      override: {
        extraStoves: [{ id: maxStoveId + 1, kind: "pan" }],
      },
    },
    {
      id: "extra-pot",
      title: "增设一口汤锅",
      description: `汤锅 ${potCount} → ${potCount + 1}，煎锅保持 ${panCount} 口；缓解意面排队`,
      override: {
        extraStoves: [{ id: maxStoveId + 1, kind: "pot" }],
      },
    },
    {
      id: "stock-up",
      title: "开局食材加倍备货",
      description:
        "三类初始食材各 +5（受库存上限约束），采购指令在库存已满时会被跳过并记录",
      override: {
        extraInitialStock: { beef: 5, noodle: 5, greens: 5 },
      },
    },
    {
      id: "counter-space",
      title: "扩大出餐台容量",
      description: `出餐台 ${archive.config.dishCap} → ${archive.config.dishCap + 2} 份，减少满台导致的起锅/装盘阻塞`,
      override: { dishCap: archive.config.dishCap + 2 },
    },
    {
      id: "prep-space",
      title: "扩大备料台容量",
      description: `备料台 ${archive.config.prepCap} → ${archive.config.prepCap + 2} 份，减少备料台满导致的阻塞`,
      override: { prepCap: archive.config.prepCap + 2 },
    },
  ];

  return candidates.map((c) =>
    evaluate(archive, c.id, c.title, c.description, c.override, baseline),
  );
}

export { describeCommand };
