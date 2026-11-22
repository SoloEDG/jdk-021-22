export { default as DiagnosisPanel } from "./ui/DiagnosisPanel.vue";
export { buildReport } from "./model/report";
export type { DiagnosticReport, ComparisonReport } from "./model/report";
export {
  archiveRound,
  saveArchive,
  loadArchives,
  isComparable,
  comparableReason,
  findComparable,
  buildConfig,
  configKey,
  flowKey,
} from "./model/archive";
export type { RoundArchive, RoundConfig } from "../../shared/types";
export { analyzeTimeline, phaseLabel, blockerLabel } from "./model/timeline";
export type {
  TimelineAnalysis,
  OrderTimeline,
  PhaseKind,
  BlockerTag,
  PhaseInterval,
} from "./model/timeline";
export type { LossReport, LossItem } from "./model/loss";
export type { ImprovementReport, OrderImpact, SkippedCommand } from "./model/improvements";
export { describeCommand } from "./model/improvements";
export type { RescheduleReport } from "./model/reschedule";
export { replay } from "./model/simulator";
