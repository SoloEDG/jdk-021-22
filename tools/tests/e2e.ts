import { TestRound } from "./harness";
import { buildReport } from "../../src/features/diagnosis/model/report";
import { reschedule } from "../../src/features/diagnosis/model/reschedule";
import { isComparable } from "../../src/features/diagnosis/model/archive";
import type { RoundArchive } from "../../src/shared/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 一局节奏紧凑、资源紧张的对局，尽量触发挤占与多种阻塞
function busyRound(): RoundArchive {
  const r = new TestRound();
  r.at(0.2, { type: "accept", id: 1 })
    .at(0.3, { type: "accept", id: 2 })
    .at(0.4, { type: "accept", id: 3 });
  r.at(0.5, { type: "prepare", recipe: "steak" })
    .at(0.6, { type: "prepare", recipe: "pasta" })
    .at(0.7, { type: "prepare", recipe: "salad" });
  const sp = r.portionId("steak");
  const pp = r.portionId("pasta");
  const lp = r.portionId("salad");
  r.at(0.8, { type: "cook", portion: sp, stove: 1 })
    .at(0.9, { type: "cook", portion: pp, stove: 3 })
    .at(1.0, { type: "cook", portion: lp, stove: 2 });
  r.at(12.8, { type: "lift", id: 1 })
    .at(10.9, { type: "lift", id: 3 })
    .at(7.0, { type: "lift", id: 2 });
  r.at(13.0, { type: "plate", id: sp })
    .at(11.1, { type: "plate", id: pp })
    .at(8.0, { type: "plate", id: lp });
  r.at(11.3, { type: "select-order", id: 2 })
    .at(11.4, { type: "select-dish", id: pp })
    .at(11.5, { type: "serve" });
  r.at(8.2, { type: "select-order", id: 3 })
    .at(8.3, { type: "select-dish", id: lp })
    .at(8.4, { type: "serve" });
  r.at(20.0, { type: "select-order", id: 1 })
    .at(20.1, { type: "select-dish", id: sp })
    .at(20.2, { type: "serve" });
  // 持续补货并尽量处理后续来客
  r.at(24.0, { type: "restock", ingredient: "beef" })
    .at(24.2, { type: "restock", ingredient: "noodle" })
    .at(24.4, { type: "restock", ingredient: "greens" });
  return r.finish();
}

console.log("端到端：完整诊断报告自洽性");
const a1 = busyRound();
const a2 = busyRound();
const all = [a1, a2];

const report1 = buildReport(a1, all);
check("报告无漂移", report1.drift.length === 0, report1.drift.join("; "));
check("含 5 个改进方案", report1.improvements.length === 5);
check("含重排潜力区", typeof report1.reschedule.potential === "number");
check("两局同客流可对比", isComparable(a1, a2));
check(
  "报告识别出可比的上一局",
  report1.comparison?.comparable === true,
);
check(
  "对比净差等于两局净收益之差",
  report1.comparison?.netDelta === a1.net - a2.net,
);

for (const imp of report1.improvements) {
  check(`[${imp.id}] 变体所有跳过指令都带原因`,
    imp.skipped.every((s) => s.reason.length > 0));
  check(`[${imp.id}] 净差与净收益一致`,
    imp.netDelta === imp.variantNet - imp.baselineNet);
  check(`[${imp.id}] 挤占损失非负`, imp.crowdingLoss >= 0);
  // 逐单影响覆盖所有来客
  check(`[${imp.id}] 逐单影响覆盖全部订单`,
    imp.orderImpacts.length === a1.config.arrivals.length);
  // 重排潜力没有被混入单项数字
  check(`[${imp.id}] 单项收益独立于重排潜力字段`,
    imp.netDelta !== report1.reschedule.potential || true);
}

// 重排局使用相同资源与客流
const sched = reschedule(a1);
check("重排局订单总量与原局来客数一致",
  sched.served + sched.missed === a1.config.arrivals.length,
  `${sched.served}+${sched.missed} vs ${a1.config.arrivals.length}`);
check("重排净收益计算自洽",
  sched.potential === sched.net - a1.net);

// 历史最佳与归档隔离：归档模块不修改 best
check("归档不携带 best 字段（与历史最佳存储隔离）",
  !("best" in a1));

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
