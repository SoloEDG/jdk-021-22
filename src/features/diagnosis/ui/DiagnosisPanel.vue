<script setup lang="ts">
import { computed } from "vue";
import type { RoundArchive } from "../../../shared/types";
import {
  buildReport,
  phaseLabel,
  blockerLabel,
  describeCommand,
} from "../index";
import { recipes } from "../../../shared/catalog";

const props = defineProps<{ archive: RoundArchive; all: RoundArchive[] }>();

const report = computed(() => buildReport(props.archive, props.all));
const r = report;

const phaseKeys = ["intake", "prep", "stove", "cook", "serve"] as const;
const blockerKeys = [
  "idle",
  "ingredient",
  "prep-cap",
  "stove-busy",
  "stove-kind",
  "stove-and-food",
  "counter-cap",
  "counter-and-action",
  "action",
] as const;

function fmt(t: number): string {
  return `${t.toFixed(1)}s`;
}
function money(n: number): string {
  return `${n >= 0 ? "+" : "−"}¥${Math.abs(n)}`;
}
function maxSpan(): number {
  return Math.max(1, ...r.value.timeline.orders.map((o) => o.span));
}
</script>

<template>
  <div class="diagnosis">
    <!-- 重演可信度 -->
    <div
      class="diag-banner"
      :class="r.drift.length ? 'bad' : 'ok'"
      v-if="r.drift.length === 0"
    >
      ✓ 基线重演与现场账本逐笔一致，诊断归因可信
    </div>
    <div class="diag-banner bad" v-else>
      <b>重演与现场存在偏差，以下归因仅供参考：</b>
      <span v-for="(d, i) in r.drift" :key="i">· {{ d }}</span>
    </div>

    <!-- 1. 逐单时间构成 -->
    <section class="diag-section">
      <h3>① 每单时间构成（五段互斥，不重复相加）</h3>
      <p class="diag-hint">
        同一时刻每单只归入一个阶段；阻塞按“单因子解除能否推进”判定，
        须同时解除多因才能推进的标记为联合阻塞。
      </p>
      <div class="order-timelines">
        <article v-for="o in r.timeline.orders" :key="o.orderId" class="tl-card">
          <header>
            <b>#{{ String(o.orderId).padStart(3, "0") }}
              {{ recipes[o.recipe].icon }} {{ recipes[o.recipe].name }}</b>
            <span :class="o.outcome === 'served' ? 'ok-text' : 'bad-text'">
              {{ o.outcome === "served" ? "已成交" : "已离店" }}
            </span>
          </header>
          <div class="stack-bar">
            <span
              v-for="k in phaseKeys"
              :key="k"
              :class="`seg seg-${k}`"
              :style="{ width: (o.totals[k] / maxSpan()) * 100 + '%' }"
              :title="`${phaseLabel(k)} ${fmt(o.totals[k])}`"
            ></span>
          </div>
          <div class="phase-grid">
            <span v-for="k in phaseKeys" :key="k">
              <i :class="`dot dot-${k}`"></i>{{ phaseLabel(k) }}
              <b>{{ fmt(o.totals[k]) }}</b>
            </span>
          </div>
          <ul class="blocker-list">
            <li v-for="k in blockerKeys" :key="k" v-show="o.blocked[k] > 0">
              <span :class="{ joint: k.includes('and') }">{{ blockerLabel(k) }}</span>
              <b>{{ fmt(o.blocked[k]) }}</b>
            </li>
          </ul>
        </article>
      </div>
    </section>

    <!-- 2. 损失定位 -->
    <section class="diag-section">
      <h3>② 损失定位（映射回当时场景）</h3>
      <div class="loss-summary">
        <span>超时赔付 <b class="bad-text">−¥{{ r.losses.missTotal }}</b></span>
        <span>丢弃浪费 <b class="bad-text">−¥{{ r.losses.wasteTotal }}</b></span>
        <span>火候折损 <b class="warn-text">−¥{{ r.losses.qualityGap }}</b></span>
        <span>失温折损 <b class="warn-text">−¥{{ r.losses.freshnessGap }}</b></span>
        <span>采购支出 <b>−¥{{ r.losses.supplyTotal }}</b></span>
      </div>
      <table class="loss-table">
        <thead>
          <tr><th>时刻</th><th>项目</th><th>金额</th><th>当时场景</th></tr>
        </thead>
        <tbody>
          <tr v-for="(it, i) in r.losses.items" :key="i">
            <td>{{ fmt(it.time) }}</td>
            <td>{{ it.title }}</td>
            <td :class="it.category === 'supply' ? '' : 'bad-text'">
              −¥{{ it.amount }}
            </td>
            <td class="scene-cell">{{ it.scene }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 3. 单项改进：原客流重演 -->
    <section class="diag-section">
      <h3>③ 改进建议（均用原局客流与原动作时刻重演）</h3>
      <p class="diag-hint">
        仅改变资源，不改变你的操作时刻；因资源变化而失效的动作会跳过并说明原因，
        并列出对其他订单的挤占损失。
      </p>
      <div class="improve-list">
        <article
          v-for="imp in r.improvements"
          :key="imp.id"
          class="improve-card"
          :class="{ positive: imp.netDelta > 0 }"
        >
          <header>
            <b>{{ imp.title }}</b>
            <span class="delta" :class="imp.netDelta > 0 ? 'ok-text' : ''">
              {{ money(imp.netDelta) }}
            </span>
          </header>
          <p class="diag-hint">{{ imp.description }}</p>
          <div class="improve-metrics">
            <span>净收益 ¥{{ imp.baselineNet }} → <b>¥{{ imp.variantNet }}</b></span>
            <span>成交 {{ imp.baselineServed }} → {{ imp.variantServed }} 单</span>
            <span>离店 {{ imp.baselineMissed }} → {{ imp.variantMissed }} 位</span>
          </div>
          <div class="recon" v-for="(x, i) in imp.reconciliation" :key="i">{{ x }}</div>
          <div class="crowd" v-if="imp.crowdingLoss > 0">
            <b class="bad-text">挤占损失 −¥{{ imp.crowdingLoss }}</b>
            <ul><li v-for="(n, i) in imp.crowdingNotes" :key="i">{{ n }}</li></ul>
          </div>
          <details v-if="imp.skipped.length">
            <summary>失效/跳过的动作（{{ imp.skipped.length }} 条）</summary>
            <ul class="skip-list">
              <li v-for="(s, i) in imp.skipped" :key="i">
                <code>t={{ fmt(s.time) }} {{ describeCommand(s.command) }}</code>
                <em v-if="s.liveApplied" class="skip-tag live">资源变化导致失效</em>
                <em v-else class="skip-tag muted">原局本就被拒</em>
                <span>{{ s.reason }}</span>
              </li>
            </ul>
          </details>
          <details>
            <summary>逐单影响（{{ imp.orderImpacts.length }} 单）</summary>
            <table class="impact-table">
              <thead>
                <tr><th>订单</th><th>原局</th><th>改进后</th><th>差额</th><th>说明</th></tr>
              </thead>
              <tbody>
                <tr v-for="oi in imp.orderImpacts" :key="oi.orderId"
                  :class="{ crowded: oi.crowding }">
                  <td>#{{ String(oi.orderId).padStart(3, "0") }}
                    {{ recipes[oi.recipe].icon }}</td>
                  <td>{{ oi.baselineOutcome === "served" ? `成交¥${oi.baselineIncome}` : "离店" }}</td>
                  <td>{{ oi.variantOutcome === "served" ? `成交¥${oi.variantIncome}` : "离店" }}</td>
                  <td :class="oi.delta > 0 ? 'ok-text' : oi.delta < 0 ? 'bad-text' : ''">
                    {{ money(oi.delta) }}
                  </td>
                  <td>{{ oi.note }}</td>
                </tr>
              </tbody>
            </table>
          </details>
        </article>
      </div>
    </section>

    <!-- 4. 重新调度潜力（独立分区） -->
    <section class="diag-section reschedule">
      <h3>④ 重新调度潜力（独立测算，不并入任何单项改进）</h3>
      <div class="reschedule-box">
        <div>
          自动调度净收益 <b>¥{{ r.reschedule.net }}</b>
          （成交 {{ r.reschedule.served }} 单 / 离店 {{ r.reschedule.missed }} 位）
        </div>
        <div class="delta" :class="r.reschedule.potential > 0 ? 'ok-text' : ''">
          相对原局潜在空间 {{ money(r.reschedule.potential) }}
        </div>
        <p class="diag-hint">{{ r.reschedule.note }}</p>
      </div>
    </section>

    <!-- 5. 局间对比 -->
    <section class="diag-section" v-if="r.comparison">
      <h3>⑤ 与上一局对比</h3>
      <div class="compare-banner" :class="r.comparison.comparable ? 'ok' : 'warn'">
        {{ r.comparison.reason }}
      </div>
      <template v-if="r.comparison.comparable">
        <div class="improve-metrics">
          <span>净收益差 <b :class="r.comparison.netDelta >= 0 ? 'ok-text' : 'bad-text'">
            {{ money(r.comparison.netDelta) }}</b></span>
          <span>成交差 {{ r.comparison.servedDelta }} 单</span>
          <span>离店差 {{ r.comparison.missedDelta }} 位</span>
        </div>
      </template>
    </section>
  </div>
</template>
