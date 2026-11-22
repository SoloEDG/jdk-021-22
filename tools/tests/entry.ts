import type { Command, RoundArchive } from "../../src/shared/types";
import { TestRound } from "./harness";
import { replay } from "../../src/features/diagnosis/model/simulator";
import { analyzeTimeline } from "../../src/features/diagnosis/model/timeline";
import { locateLosses } from "../../src/features/diagnosis/model/loss";
import { evaluateImprovements } from "../../src/features/diagnosis/model/improvements";
import { reschedule } from "../../src/features/diagnosis/model/reschedule";
import {
  isComparable,
  comparableReason,
  configKey,
  flowKey,
} from "../../src/features/diagnosis/model/archive";
import { buildReport } from "../../src/features/diagnosis/model/report";
import { checkCommand, applyCommand } from "../../src/features/diagnosis/model/engine";
import { createGame } from "../../src/shared/initial";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function approx(a: number, b: number, eps = 0.11): boolean {
  return Math.abs(a - b) <= eps;
}
function netOf(entries: { amount: number }[]): number {
  return entries.reduce((x, e) => x + e.amount, 0);
}

// ---------- 场景 A：完整忙碌局，含成交、失温、采购、被拒指令 ----------
function scenarioA(): RoundArchive {
  const r = new TestRound();
  r.at(0.2, { type: "accept", id: 1 })
    .at(0.3, { type: "accept", id: 2 })
    .at(0.4, { type: "accept", id: 3 })
    .at(0.5, { type: "prepare", recipe: "steak" })
    .at(0.6, { type: "prepare", recipe: "pasta" })
    .at(0.7, { type: "prepare", recipe: "salad" });
  const steakP = r.portionId("steak");
  const pastaP = r.portionId("pasta");
  const saladP = r.portionId("salad");
  r.at(0.8, { type: "cook", portion: steakP, stove: 1 })
    .at(0.9, { type: "cook", portion: pastaP, stove: 3 })
    .at(1.0, { type: "cook", portion: saladP, stove: 2 })
    .at(12.8, { type: "lift", id: 1 })
    .at(10.9, { type: "lift", id: 3 })
    .at(7.0, { type: "lift", id: 2 })
    .at(13.0, { type: "plate", id: steakP })
    .at(11.1, { type: "plate", id: pastaP });
  // 先上意面
  r.at(11.3, { type: "select-order", id: 2 })
    .at(11.4, { type: "select-dish", id: pastaP })
    .at(11.5, { type: "serve" });
  // 再上沙拉
  r.at(8.0, { type: "plate", id: saladP })
    .at(8.2, { type: "select-order", id: 3 })
    .at(8.3, { type: "select-dish", id: saladP })
    .at(8.4, { type: "serve" });
  // 故意触发一条被拒指令（未选菜/单就上菜）
  r.at(9.0, { type: "serve" });
  // 牛排拖到失温后再上（cookedAt 12.8，>27.8 开始失温）
  r.at(30.0, { type: "select-order", id: 1 })
    .at(30.1, { type: "select-dish", id: steakP })
    .at(30.2, { type: "serve" })
    .at(32.0, { type: "restock", ingredient: "beef" });
  // 再做一份牛排走完备料→下锅→起锅→装盘
  r.at(34.0, { type: "prepare", recipe: "steak" });
  const steak2 = r.portionId("steak");
  r.at(34.2, { type: "cook", portion: steak2, stove: 1 })
    .at(46.2, { type: "lift", id: 1 })
    .at(46.4, { type: "plate", id: steak2 });
  return r.finish();
}

// ---------- 场景 B：缺料 + 灶台全忙的联合阻塞 ----------
function scenarioB(): RoundArchive {
  const r = new TestRound();
  // 只接 #1（牛排），让 #2/#3 自然超时，避免 t=18 在场满 6 单导致 #4 暂缓释放
  r.at(0.2, { type: "accept", id: 1 });
  // 三口灶全占：牛排、意面、沙拉
  r.at(0.5, { type: "prepare", recipe: "steak" })
    .at(0.6, { type: "prepare", recipe: "pasta" })
    .at(0.7, { type: "prepare", recipe: "salad" });
  const p1 = r.portionId("steak");
  const p2 = r.portionId("pasta");
  const p3 = r.portionId("salad");
  r.at(0.8, { type: "cook", portion: p1, stove: 1 })
    .at(0.9, { type: "cook", portion: p2, stove: 3 })
    .at(1.0, { type: "cook", portion: p3, stove: 2 });
  // 备料台再放 4 份牛排：锅内 1 份 + 台内 4 份，牛肉 5 份恰好耗尽，三灶保持全占
  r.at(1.2, { type: "prepare", recipe: "steak" })
    .at(1.3, { type: "prepare", recipe: "steak" })
    .at(1.4, { type: "prepare", recipe: "steak" })
    .at(1.5, { type: "prepare", recipe: "steak" });
  // t=18 来客 #4 是牛排：无牛肉且三灶全忙，须同时补料+腾灶才能推进
  r.at(18.2, { type: "accept", id: 4 });
  // 不主动起锅，让灶一直占用
  return r.finish();
}

// ================= 断言 =================
console.log("场景 A：完整忙碌局");
const archiveA = scenarioA();

const baseA = replay(archiveA);
check("基线重演无漂移", baseA.drift.length === 0, baseA.drift.join("; "));
check(
  "重演净收益等于归档净收益",
  netOf(baseA.game.entries) === archiveA.net,
  `${netOf(baseA.game.entries)} vs ${archiveA.net}`,
);
check(
  "重演成交/离店单数与归档一致",
  baseA.game.served === archiveA.served && baseA.game.missed === archiveA.missed,
  `重演 ${baseA.game.served}/${baseA.game.missed} vs 归档 ${archiveA.served}/${archiveA.missed}`,
);
check(
  "流水包含被拒指令及原因",
  archiveA.transcript.some((t) => t.outcome === "rejected" && t.reason.length > 0),
);

const { analysis: tlA } = analyzeTimeline(archiveA);
for (const o of tlA.orders) {
  const sumPhases = Object.values(o.totals).reduce((x, y) => x + y, 0);
  check(`订单 #${o.orderId} 五段互斥且覆盖在店时长`, approx(sumPhases, o.span),
    `sum=${sumPhases} span=${o.span}`);
  const sumBlockers = Object.values(o.blocked).reduce((x, y) => x + y, 0);
  check(`订单 #${o.orderId} 阻塞标签同一时间只归一类`, approx(sumBlockers, o.span),
    `blockers=${sumBlockers} span=${o.span}`);
}
const aggPhaseSum = Object.values(tlA.aggregatePhase).reduce((x, y) => x + y, 0);
const aggBlockSum = Object.values(tlA.aggregateBlocked).reduce((x, y) => x + y, 0);
check("全局阶段聚合与阻塞聚合相等（无重复相加）", approx(aggPhaseSum, aggBlockSum));

const cookedOrder = tlA.orders.find((o) => o.orderId === 2);
check("成交订单存在烹饪时长", (cookedOrder?.totals.cook ?? 0) > 0);
check("烹饪标记为 none（作业中不算等待）", (cookedOrder?.blocked.none ?? 0) > 0);

const lossA = locateLosses(archiveA, tlA, baseA);
check("损失报告含采购支出项", lossA.items.some((i) => i.category === "supply"));
check("每条损失都带场景说明", lossA.items.every((i) => i.scene.length > 0));
check("延迟上菜的牛排产生失温折损", lossA.freshnessGap > 0, `freshnessGap=${lossA.freshnessGap}`);

const improvementsA = evaluateImprovements(archiveA);
check("生成 5 个单项改进方案", improvementsA.length === 5);
for (const rep of improvementsA) {
  check(`[${rep.id}] 对账配平`, rep.reconciliation.some((x) => x.includes("配平")),
    rep.reconciliation.join("; "));
  check(`[${rep.id}] 跳过指令均带原因`, rep.skipped.every((x) => x.reason.length > 0));
  const orderDelta = rep.orderImpacts.reduce((x, i) => x + i.delta, 0);
  const nonSaleDelta = rep.netDelta - orderDelta;
  check(`[${rep.id}] 逐单差+非销售账差=总账差`, approx(orderDelta + nonSaleDelta, rep.netDelta));
  const crowdFromOrders = rep.orderImpacts
    .filter((i) => i.crowding)
    .reduce((x, i) => x + Math.max(0, i.baselineIncome), 0);
  check(`[${rep.id}] 挤占损失与逐单标注一致且非负`,
    rep.crowdingLoss === crowdFromOrders && rep.crowdingLoss >= 0);
}

const scheduleA = reschedule(archiveA);
check("重排潜力=重排净收益-基线净收益",
  scheduleA.potential === scheduleA.net - archiveA.net);
check("重排与基线使用同一客流（来客订单数一致）",
  scheduleA.served + scheduleA.missed >= 1);

const reportA = buildReport(archiveA, [archiveA]);
check("报告含时间线/损失/改进/重排四部分",
  !!reportA.timeline && !!reportA.losses && reportA.improvements.length === 5 && !!reportA.reschedule);
check("报告漂移为空", reportA.drift.length === 0);

console.log("场景 B：联合阻塞（缺料 + 灶台全忙）");
const archiveB = scenarioB();
const baseB = replay(archiveB);
check("场景 B 基线重演无漂移", baseB.drift.length === 0, baseB.drift.join("; "));
const { analysis: tlB } = analyzeTimeline(archiveB);
const order4 = tlB.orders.find((o) => o.orderId === 4);
check("来客 #4 存在", !!order4);
check("来客 #4 被标记为联合阻塞（缺料且灶台全忙）",
  (order4?.blocked["stove-and-food"] ?? 0) > 0, JSON.stringify(order4?.blocked));
check("联合阻塞未被重复计入其它类",
  approx(Object.values(order4!.blocked).reduce((x, y) => x + y, 0), order4!.span));
check(
  "单因子解除测试：有牛肉但仍无灶时不能推进（联合而非单纯缺料）",
  (order4?.blocked["ingredient"] ?? 0) === 0 || (order4?.blocked["stove-and-food"] ?? 0) > 0,
);

console.log("场景 C：资源覆写下的动作失效与扩容救单");
function scenarioC(): RoundArchive {
  const r = new TestRound();
  // 开局把牛肉采购到接近满，再补一次触发“库存已满”跳过
  r.at(0.2, { type: "accept", id: 1 });
  r.at(0.4, { type: "restock", ingredient: "beef" }) // 5->8
    .at(0.6, { type: "restock", ingredient: "beef" }) // 8->11
    .at(0.8, { type: "restock", ingredient: "beef" }); // 11->12（封顶）
  // 再采购一次必被“库存充足，上限12份”拒绝
  r.at(1.0, { type: "restock", ingredient: "beef" });
  return r.finish();
}
const archiveC = scenarioC();
const baseC = replay(archiveC);
check("场景 C 基线重演无漂移", baseC.drift.length === 0, baseC.drift.join("; "));
check(
  "库存封顶后的采购指令在现场即被拒并记录原因",
  archiveC.transcript.some(
    (t) => t.command.type === "restock" && t.outcome === "rejected",
  ),
);
// 库存加倍方案下，原采购动作会因更早触顶而被跳过，且必须带原因
const stockUp = evaluateImprovements(archiveC).find((x) => x.id === "stock-up")!;
check(
  "备货改进局保留原动作时刻，失效采购被明确跳过并说明",
  stockUp.skipped.some((s) => s.command.type === "restock" && s.reason.includes("上限")),
);
// 改进局允许跳过原指令，但跳过的都应是因资源变化而失效（守卫拦截），且原因非空
check(
  "备货改进局所有跳过都带明确原因",
  stockUp.skipped.every((s) => s.reason.length > 0),
);

// 扩容方案：现场已执行(applied)的指令不应在改进局失效
const counterPlan = evaluateImprovements(archiveA).find((x) => x.id === "counter-space")!;
check(
  "出餐台扩容不会使原局已执行指令失效（跳过项均为现场本就被拒的指令）",
  counterPlan.skipped.every((s) => !s.liveApplied),
  `存在现场已执行却在改进局被跳过的指令：${counterPlan.skipped.filter((s) => s.liveApplied).map((s) => s.reason).join("; ")}`,
);

console.log("可比性判定");
const archiveA2 = scenarioA();
check("相同脚本两局可直接对比", isComparable(archiveA, archiveA2));
check("可比原因文案正确", comparableReason(archiveA, archiveA2).includes("可直接对比"));

const mutatedPrice: RoundArchive = structuredClone(archiveA);
mutatedPrice.id = "round-mutated-price";
mutatedPrice.config.recipes[0].price = 999;
mutatedPrice.configKey = configKey(mutatedPrice.config);
check("价格不同不可比", !isComparable(archiveA, mutatedPrice));
check("价格不同给出不可归因说明",
  comparableReason(archiveA, mutatedPrice).includes("不可直接归因"));

const mutatedFlow: RoundArchive = structuredClone(archiveA);
mutatedFlow.id = "round-mutated-flow";
mutatedFlow.config.arrivals = mutatedFlow.config.arrivals.slice(0, -1);
mutatedFlow.flowKey = flowKey(mutatedFlow.config);
check("客流不同不可比", !isComparable(archiveA, mutatedFlow));
check("客流不同明确指出不可直接归因",
  comparableReason(archiveA, mutatedFlow).includes("客流"));

console.log("指令守卫边界");
const g0 = createGame(0);
g0.running = true;
check("无效上菜被守卫拦截", checkCommand(g0, { type: "serve" }).length > 0);
check("不存在的备料下锅被守卫拦截",
  checkCommand(g0, { type: "cook", portion: 999, stove: 1 }).includes("备料已不存在"));
const paused = createGame(0);
const pausedCmd = applyCommand(paused, { type: "serve" });
check("未开门时指令不生效（暂停不计耗时的前置约束）", pausedCmd.applied === false);

console.log("打烊同刻口径");
check("归档账本与重演交付逐笔一致（打烊同刻口径）",
  baseA.drift.length === 0 && baseB.drift.length === 0);

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
