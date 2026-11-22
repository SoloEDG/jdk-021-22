import type {
  Game,
  Order,
  RecipeId,
  RoundArchive,
} from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { replay, type ReplayResult } from "./simulator";

export type PhaseKind = "intake" | "prep" | "stove" | "cook" | "serve";

export type BlockerTag =
  | "none"
  | "idle"
  | "ingredient"
  | "prep-cap"
  | "stove-busy"
  | "stove-kind"
  | "stove-and-food"
  | "counter-cap"
  | "counter-and-action"
  | "action";

export interface PhaseInterval {
  kind: PhaseKind;
  blocker: BlockerTag;
  start: number;
  end: number;
  detail: string;
}

export interface OrderTimeline {
  orderId: number;
  recipe: RecipeId;
  guest: string;
  arrived: number;
  deadline: number;
  endTime: number;
  outcome: "served" | "left";
  intervals: PhaseInterval[];
  blocked: Record<BlockerTag, number>;
  totals: Record<PhaseKind, number>;
  span: number;
}

export interface TimelineAnalysis {
  orders: OrderTimeline[];
  aggregateBlocked: Record<BlockerTag, number>;
  aggregatePhase: Record<PhaseKind, number>;
  sceneLoad: { time: number; blockedOrderCount: number }[];
}

const PHASE_LABEL: Record<PhaseKind, string> = {
  intake: "待接单",
  prep: "缺料/备料等待",
  stove: "等锅",
  cook: "烹饪",
  serve: "等上菜",
};

const BLOCKER_LABEL: Record<BlockerTag, string> = {
  none: "作业中",
  idle: "可推进未操作",
  ingredient: "食材不足",
  "prep-cap": "备料台满",
  "stove-busy": "灶台全忙",
  "stove-kind": "匹配灶型被占",
  "stove-and-food": "缺料且灶台全忙（联合阻塞）",
  "counter-cap": "出餐台满",
  "counter-and-action": "出餐台满且未装盘/上菜（联合阻塞）",
  action: "等待玩家操作",
};

export function phaseLabel(k: PhaseKind): string {
  return PHASE_LABEL[k];
}
export function blockerLabel(t: BlockerTag): string {
  return BLOCKER_LABEL[t];
}

interface Lineage {
  portionOrder: Map<number, number>;
  dishOrder: Map<number, number>;
}

interface TickSnapshot {
  time: number;
  orders: Order[];
  stock: Game["stock"];
  prepCap: number;
  dishCap: number;
  portions: { id: number; recipe: RecipeId }[];
  stoves: { id: number; kind: "pan" | "pot"; portionId: number | null }[];
  dishes: { id: number; recipe: RecipeId; stage: "counter" | "plated" }[];
}

function stationOf(recipe: RecipeId): "pan" | "pot" {
  return recipes[recipe].station;
}

/**
 * 通过相邻快照差分恢复 portion/dish 与订单的归属：
 * - 下锅瞬间按同菜谱已接订单 FIFO 绑定（id 沿用 portion id，故可直接追踪到 dish）
 * - 成交瞬间用“本 tick 消失的菜品 + 本 tick 成交的同菜谱订单”确认/改绑
 */
function buildLineage(snapshots: TickSnapshot[]): Lineage {
  const portionOrder = new Map<number, number>();
  const dishOrder = new Map<number, number>();

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];

    // 下锅：portion 从备料台消失、某灶新增占用
    for (const stove of cur.stoves) {
      if (stove.portionId == null) continue;
      const wasOnPrevStove = prev.stoves.some(
        (s) => s.portionId === stove.portionId,
      );
      const wasOnPrep = prev.portions.some((p) => p.id === stove.portionId);
      if (!wasOnPrevStove && wasOnPrep && !portionOrder.has(stove.portionId)) {
        const portion = prev.portions.find((p) => p.id === stove.portionId)!;
        const target = cur.orders
          .filter((o) => o.status === "accepted" && o.recipe === portion.recipe)
          .sort((a, b) => a.arrived - b.arrived || a.id - b.id)[0];
        if (target) portionOrder.set(stove.portionId, target.id);
      }
    }

    // 成交/丢弃：菜品消失。若同 tick 有同菜谱订单成交，确认绑定
    for (const d of prev.dishes) {
      if (cur.dishes.some((x) => x.id === d.id)) continue;
      const justServed = cur.orders
        .filter(
          (o) =>
            prev.orders.find((x) => x.id === o.id)?.status !== "served" &&
            o.status === "served" &&
            o.recipe === d.recipe,
        )
        .sort((a, b) => a.id - b.id);
      if (justServed.length) {
        dishOrder.set(d.id, justServed[0].id);
        portionOrder.set(d.id, justServed[0].id);
      }
    }
  }
  return { portionOrder, dishOrder };
}

function emptyBlocked(): Record<BlockerTag, number> {
  return {
    none: 0,
    idle: 0,
    ingredient: 0,
    "prep-cap": 0,
    "stove-busy": 0,
    "stove-kind": 0,
    "stove-and-food": 0,
    "counter-cap": 0,
    "counter-and-action": 0,
    action: 0,
  };
}
function emptyPhase(): Record<PhaseKind, number> {
  return { intake: 0, prep: 0, stove: 0, cook: 0, serve: 0 };
}

/**
 * 单因子解除测试：
 * - 仅移除一个阻塞因子即可推进下一步 => 单因阻塞；
 * - 必须同时移除多个因子才能推进 => 联合阻塞。
 */
function classify(
  snap: TickSnapshot,
  order: Order,
  lineage: Lineage,
): { kind: PhaseKind; blocker: BlockerTag; detail: string } {
  const r = order.recipe;
  const station = stationOf(r);

  if (order.status === "waiting") {
    return { kind: "intake", blocker: "action", detail: "等待玩家接单" };
  }

  // 在灶上 -> 烹饪（作业中，不产生等待损失）
  const onStove = snap.stoves.find(
    (s) =>
      s.portionId != null && lineage.portionOrder.get(s.portionId) === order.id,
  );
  if (onStove) {
    return { kind: "cook", blocker: "none", detail: "菜品正在灶上烹饪" };
  }

  // 已起锅、在出餐台 -> 等上菜
  const myDish = snap.dishes.find(
    (d) => lineage.dishOrder.get(d.id) === order.id,
  );
  if (myDish) {
    const counterFull = snap.dishes.length >= snap.dishCap;
    if (myDish.stage === "counter") {
      if (counterFull) {
        // 只“装盘”无法推进（无台位），必须同时腾台并装盘 -> 联合
        return {
          kind: "serve",
          blocker: "counter-and-action",
          detail: "出餐台已满，须先上菜/丢弃腾台再装盘（联合阻塞）",
        };
      }
      return {
        kind: "serve",
        blocker: "action",
        detail: "菜品待装盘，等待玩家装盘",
      };
    }
    if (counterFull) {
      return {
        kind: "serve",
        blocker: "counter-and-action",
        detail: "出餐台满且尚未上菜，腾台与上菜须同时具备（联合阻塞）",
      };
    }
    return { kind: "serve", blocker: "action", detail: "已装盘，等待上菜" };
  }

  // 已备料、在备料台 -> 等锅
  const myPortion = snap.portions.find(
    (p) => lineage.portionOrder.get(p.id) === order.id,
  );
  if (myPortion) {
    const freeKind = snap.stoves.some(
      (s) => s.kind === station && s.portionId === null,
    );
    const freeAny = snap.stoves.some((s) => s.portionId === null);
    if (freeKind) {
      return {
        kind: "stove",
        blocker: "idle",
        detail: "匹配灶台空闲，等待玩家下锅",
      };
    }
    if (freeAny) {
      return {
        kind: "stove",
        blocker: "stove-kind",
        detail: "空闲灶型不匹配，匹配灶台被占用",
      };
    }
    return { kind: "stove", blocker: "stove-busy", detail: "灶台全部占用" };
  }

  // 尚未备料 -> 缺料/备料等待
  const noStock = snap.stock[recipes[r].ingredient] < 1;
  const prepFull = snap.portions.length >= snap.prepCap;
  const freeKind = snap.stoves.some(
    (s) => s.kind === station && s.portionId === null,
  );
  const freeAnyStove = snap.stoves.some((s) => s.portionId === null);
  if (noStock) {
    // 联合测试：只补料仍无法下锅（灶台也全忙），须补料+腾灶同时具备
    if (!freeAnyStove && !freeKind) {
      return {
        kind: "prep",
        blocker: "stove-and-food",
        detail: "食材不足且灶台全忙，补料与腾灶须同时具备（联合阻塞）",
      };
    }
    return { kind: "prep", blocker: "ingredient", detail: "食材不足，等待采购" };
  }
  if (prepFull) {
    // 只备料不行（台满）；只腾备料台还需玩家执行备料动作 -> 仍记为容量单因，动作由 idle 类表达
    return { kind: "prep", blocker: "prep-cap", detail: "备料台已满，无法再备料" };
  }
  return {
    kind: "prep",
    blocker: "idle",
    detail: "食材齐备，等待玩家备料",
  };
}

function mergeIntervals(
  raw: PhaseInterval[],
): PhaseInterval[] {
  const out: PhaseInterval[] = [];
  for (const seg of raw) {
    const last = out[out.length - 1];
    if (
      last &&
      last.kind === seg.kind &&
      last.blocker === seg.blocker &&
      Math.abs(last.end - seg.start) < 1e-6
    ) {
      last.end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

function round1(t: number): number {
  return Math.round(t * 10) / 10;
}
function roundMap<T extends string>(m: Record<T, number>): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const k of Object.keys(m) as T[]) out[k] = round1(m[k]);
  return out;
}

export function analyzeTimeline(archive: RoundArchive): {
  analysis: TimelineAnalysis;
  replay: ReplayResult;
} {
  const snapshots: TickSnapshot[] = [];
  const capture = (g: Game) => {
    snapshots.push({
      time: round1(g.time),
      orders: g.orders.map((o) => ({ ...o })),
      stock: { ...g.stock },
      prepCap: g.prepCap,
      dishCap: g.dishCap,
      portions: g.portions.map((p) => ({ id: p.id, recipe: p.recipe })),
      stoves: g.stoves.map((s) => ({
        id: s.id,
        kind: s.kind,
        portionId: s.portion?.id ?? null,
      })),
      dishes: g.dishes.map((d) => ({
        id: d.id,
        recipe: d.recipe,
        stage: d.stage,
      })),
    });
  };

  const result = replay(
    archive,
    undefined,
    (g) => capture(g),
  );
  // 补一个 t=0 初始快照（首个 tick 回调发生在 0.1s）
  const initial: TickSnapshot = {
    time: 0,
    orders: archive.config.arrivals
      .filter((a) => a.arrived === 0)
      .map((a) => ({ ...a, status: "waiting" as const })),
    stock: { ...archive.config.initialStock },
    prepCap: archive.config.prepCap,
    dishCap: archive.config.dishCap,
    portions: [],
    stoves: archive.config.stoves.map((s) => ({
      id: s.id,
      kind: s.kind,
      portionId: null,
    })),
    dishes: [],
  };
  snapshots.unshift(initial);

  const lineage = buildLineage(snapshots);
  const finalGame = result.game;

  const orderAnalyses: OrderTimeline[] = [];
  const aggregateBlocked = emptyBlocked();
  const aggregatePhase = emptyPhase();

  for (const order of finalGame.orders) {
    const raw: PhaseInterval[] = [];
    const blocked = emptyBlocked();
    const totals = emptyPhase();

    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const snap = snapshots[i];
      const live = snap.orders.find((o) => o.id === order.id);
      const before = prev.orders.find((o) => o.id === order.id);
      if (!live) continue;
      if (before && (before.status === "served" || before.status === "left")) break;
      if (snap.time < live.arrived) continue;

      const c = classify(snap, live, lineage);
      const start = Math.max(prev.time, live.arrived);
      const end = snap.time;
      if (end > start + 1e-9) {
        raw.push({ ...c, start, end });
        totals[c.kind] += end - start;
        blocked[c.blocker] += end - start;
      }
    }

    const intervals = mergeIntervals(raw);
    const endOrder = finalGame.orders.find((o) => o.id === order.id)!;
    const endTime =
      endOrder.status === "served"
        ? statusSince(snapshots, order.id, "served")
        : endOrder.deadline;
    const span = round1(
      intervals.reduce((s, i) => s + (i.end - i.start), 0),
    );
    for (const k of Object.keys(blocked) as BlockerTag[])
      aggregateBlocked[k] += blocked[k];
    for (const k of Object.keys(totals) as PhaseKind[])
      aggregatePhase[k] += totals[k];

    orderAnalyses.push({
      orderId: order.id,
      recipe: order.recipe,
      guest: order.guest,
      arrived: order.arrived,
      deadline: order.deadline,
      endTime,
      outcome: endOrder.status === "served" ? "served" : "left",
      intervals,
      blocked: roundMap(blocked),
      totals: roundMap(totals),
      span,
    });
  }

  const sceneLoad = snapshots
    .filter((_, i) => i % 10 === 0)
    .map((snap) => ({
      time: snap.time,
      blockedOrderCount: snap.orders.filter((o) => {
        if (o.status !== "accepted" && o.status !== "waiting") return false;
        return classify(snap, o, lineage).blocker !== "none";
      }).length,
    }));

  return {
    analysis: {
      orders: orderAnalyses,
      aggregateBlocked: roundMap(aggregateBlocked),
      aggregatePhase: roundMap(aggregatePhase),
      sceneLoad,
    },
    replay: result,
  };
}

function statusSince(
  snapshots: TickSnapshot[],
  orderId: number,
  status: "served" | "left",
): number {
  for (let i = 0; i < snapshots.length; i++) {
    const o = snapshots[i].orders.find((x) => x.id === orderId);
    if (o?.status === status) return snapshots[i].time;
  }
  return 0;
}
