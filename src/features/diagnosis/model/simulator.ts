import type {
  Game,
  RoundArchive,
  TranscriptEntry,
  Stove,
  Ingredient,
  RecipeId,
} from "../../../shared/types";
import { createGame } from "../../../shared/initial";
import { expire } from "../../orders/model/orders";
import { applyCommand } from "./engine";

export interface ResourceOverride {
  extraStoves?: { id: number; kind: "pan" | "pot" }[];
  extraInitialStock?: Partial<Record<Ingredient, number>>;
  prepCap?: number;
  dishCap?: number;
  stockCap?: number;
}

export interface CommandTrace {
  entry: TranscriptEntry;
  applied: boolean;
  reason: string;
  time: number;
  beforeServed: number;
  afterServed: number;
  servedOrderId: number | null;
  beforeMissed: number;
  afterMissed: number;
}

export interface ServedEvent {
  time: number;
  orderId: number;
  dishId: number;
  recipe: RecipeId;
  amount: number;
  entryIndex: number;
  cookQuality: number;
  servedQuality: number;
  cookedAt: number;
}

export interface ReplayResult {
  game: Game;
  commands: CommandTrace[];
  appliedCount: number;
  skippedCount: number;
  drift: string[];
  servedEvents: ServedEvent[];
}

const TICK = 0.1;

function round1(t: number): number {
  return Math.round(t * 10) / 10;
}

/** 仅依据归档配置重建一局，不触碰任何 localStorage 与 Vue 响应式。 */
function buildGame(archive: RoundArchive, override?: ResourceOverride): Game {
  const g = createGame(0);
  const cfg = archive.config;
  g.duration = cfg.duration;
  g.prepCap = override?.prepCap ?? cfg.prepCap;
  g.dishCap = override?.dishCap ?? cfg.dishCap;
  g.stockCap = override?.stockCap ?? cfg.stockCap;
  g.stock = { ...cfg.initialStock };
  if (override?.extraInitialStock) {
    for (const [k, v] of Object.entries(override.extraInitialStock)) {
      const key = k as Ingredient;
      g.stock[key] = Math.min(g.stockCap, g.stock[key] + (v ?? 0));
    }
  }
  g.stoves = cfg.stoves.map((s) => ({ ...s, portion: null, started: 0 }));
  if (override?.extraStoves) {
    g.stoves = [
      ...g.stoves,
      ...override.extraStoves.map((s) => ({ ...s, portion: null, started: 0 })),
    ] as Stove[];
  }
  // 初始三单与后续来客都直接由归档来客表注入，保证完全可复现
  g.orders = cfg.arrivals
    .filter((a) => a.arrived === 0)
    .map((a) => ({
      id: a.id,
      recipe: a.recipe,
      guest: a.guest,
      arrived: a.arrived,
      deadline: a.deadline,
      status: "waiting" as const,
    }));
  // 来客 id 来自固定计划（1-11），动态 id（备料/菜品/账本）从 12 起，避免与订单撞号
  g.nextId = 12;
  return g;
}

function injectArrivals(g: Game, archive: RoundArchive) {
  if (activeCount(g) >= 6) return;
  for (const a of archive.config.arrivals.filter((x) => x.arrived > 0)) {
    if (round1(a.arrived) === round1(g.time)) {
      if (g.orders.some((o) => o.id === a.id)) continue;
      g.orders.push({
        id: a.id,
        recipe: a.recipe,
        guest: a.guest,
        arrived: a.arrived,
        deadline: a.deadline,
        status: "waiting",
      });
    }
  }
}

function activeCount(g: Game): number {
  return g.orders.filter(
    (o) => o.status === "waiting" || o.status === "accepted",
  ).length;
}

/**
 * 按原局客流与指令时刻重演。override 改变资源后，失效指令由统一守卫拦截，
 * 跳过原因逐条记录；现场逻辑与重演逻辑共用 applyCommand，避免规则漂移。
 */
export function replay(
  archive: RoundArchive,
  override?: ResourceOverride,
  onTick?: (g: Game) => void,
): ReplayResult {
  const g = buildGame(archive, override);
  g.running = true;
  const commands: CommandTrace[] = [];
  const servedEvents: ServedEvent[] = [];
  let ptr = 0;
  let prevDishMap = new Map<
    number,
    {
      recipe: RecipeId;
      quality: number;
      cookedAt: number;
    }
  >(
    g.dishes.map((d) => [
      d.id,
      { recipe: d.recipe, quality: d.quality, cookedAt: d.cookedAt },
    ]),
  );
  let prevStatus = new Map<number, string>(
    g.orders.map((o) => [o.id, o.status]),
  );
  let prevEntryCount = g.entries.length;

  const runPendingCommands = () => {
    while (ptr < archive.transcript.length) {
      const entry = archive.transcript[ptr];
      if (round1(entry.time) !== round1(g.time)) break;
      const beforeServed = g.served;
      const beforeMissed = g.missed;
      const beforeOrderStatus = new Map(g.orders.map((o) => [o.id, o.status]));
      const res = applyCommand(g, entry.command);
      let servedOrderId: number | null = null;
      for (const o of g.orders) {
        if (beforeOrderStatus.get(o.id) !== "served" && o.status === "served") {
          servedOrderId = o.id;
        }
      }
      commands.push({
        entry,
        applied: res.applied,
        reason: res.reason,
        time: g.time,
        beforeServed,
        afterServed: g.served,
        servedOrderId,
        beforeMissed,
        afterMissed: g.missed,
      });
      ptr++;
    }
  };

  const detectServed = () => {
    // 菜品消失 + 订单转为 served + 新增 sale 条目，三者对齐为一次成交
    const newSaleEntries = g.entries.slice(prevEntryCount);
    prevEntryCount = g.entries.length;
    for (const order of g.orders) {
      if (prevStatus.get(order.id) !== "served" && order.status === "served") {
        const sale = newSaleEntries.find((e) => e.kind === "sale");
        let dishId = -1;
        let cookQuality = 0;
        let cookedAt = 0;
        for (const [id, d] of prevDishMap) {
          if (!g.dishes.some((x) => x.id === id) && d.recipe === order.recipe) {
            dishId = id;
            cookQuality = d.quality;
            cookedAt = d.cookedAt;
            break;
          }
        }
        const servedQuality = Math.max(
          0,
          cookQuality -
            Math.floor(Math.max(0, g.time - cookedAt - 15) * 2),
        );
        servedEvents.push({
          time: g.time,
          orderId: order.id,
          dishId,
          recipe: order.recipe,
          amount: sale?.amount ?? 0,
          entryIndex: sale ? g.entries.indexOf(sale) : -1,
          cookQuality,
          servedQuality,
          cookedAt,
        });
      }
    }
    prevDishMap = new Map(
      g.dishes.map((d) => [
        d.id,
        { recipe: d.recipe, quality: d.quality, cookedAt: d.cookedAt },
      ]),
    );
    prevStatus = new Map(g.orders.map((o) => [o.id, o.status]));
  };

  while (g.time < g.duration) {
    injectArrivals(g, archive);
    runPendingCommands();
    g.time = round1(g.time + TICK);
    expire(g);
    detectServed();
    onTick?.(g);
    if (g.time >= g.duration) {
      injectArrivals(g, archive);
      runPendingCommands();
      detectServed();
      g.running = false;
      g.ended = true;
    }
  }
  // 打烊之后才下达的指令在任何资源方案下都无法生效，明确标记跳过
  while (ptr < archive.transcript.length) {
    const entry = archive.transcript[ptr];
    commands.push({
      entry,
      applied: false,
      reason: "指令晚于打烊时刻，无法执行",
      time: g.time,
      beforeServed: g.served,
      afterServed: g.served,
      servedOrderId: null,
      beforeMissed: g.missed,
      afterMissed: g.missed,
    });
    ptr++;
  }

  // 漂移校验仅对无覆写的基线重演有意义；资源覆写局本来就允许跳过原指令
  const drift = override ? [] : baselineDrift(archive, g, commands);
  return {
    game: g,
    commands,
    appliedCount: commands.filter((c) => c.applied).length,
    skippedCount: commands.filter((c) => !c.applied).length,
    drift,
    servedEvents,
  };
}

/** 基线重演（无覆写）必须与归档账本逐笔一致，否则诊断不可信。 */
function baselineDrift(
  archive: RoundArchive,
  g: Game,
  commands: CommandTrace[],
): string[] {
  if (commands.some((c) => c.entry.outcome === "applied" && !c.applied)) {
    return ["重演无法复现现场：原局已执行的指令在基线重演中被跳过"];
  }
  const problems: string[] = [];
  if (g.entries.length !== archive.ledger.length) {
    problems.push(
      `账本笔数不一致：现场 ${archive.ledger.length} 笔，重演 ${g.entries.length} 笔`,
    );
  }
  const n = Math.min(g.entries.length, archive.ledger.length);
  for (let i = 0; i < n; i++) {
    const a = archive.ledger[i];
    const b = g.entries[i];
    if (
      round1(a.time) !== round1(b.time) ||
      a.amount !== b.amount ||
      a.kind !== b.kind
    ) {
      problems.push(
        `第 ${i + 1} 笔账本不一致：现场 ${a.kind}@${a.time}s ¥${a.amount} / 重演 ${b.kind}@${b.time}s ¥${b.amount}`,
      );
    }
  }
  if (g.served !== archive.served || g.missed !== archive.missed) {
    problems.push(
      `单数不一致：现场 ${archive.served}成/${archive.missed}失，重演 ${g.served}成/${g.missed}失`,
    );
  }
  const liveNet = g.entries.reduce((s, e) => s + e.amount, 0);
  if (liveNet !== archive.net) {
    problems.push(`净收益不一致：现场 ¥${archive.net} / 重演 ¥${liveNet}`);
  }
  return problems;
}

export function recipeSignature(archive: RoundArchive): string {
  return archive.config.recipes
    .map(
      (r) =>
        `${r.id}:${r.ingredient}:${r.station}:${r.target}:${r.price}`,
    )
    .join("|");
}

export function flowSignature(archive: RoundArchive): string {
  return archive.config.arrivals
    .map((a) => `${a.id}@${a.arrived}:${a.recipe}:${a.deadline}`)
    .join("|");
}
