import type { RoundArchive } from "../../../shared/types";
import { replay } from "./simulator";
import { analyzeTimeline, type TimelineAnalysis } from "./timeline";
import { locateLosses, type LossReport } from "./loss";
import {
  evaluateImprovements,
  type ImprovementReport,
} from "./improvements";
import { reschedule, type RescheduleReport } from "./reschedule";
import {
  comparableReason,
  findComparable,
  isComparable,
} from "./archive";

export interface ComparisonReport {
  other: RoundArchive;
  comparable: boolean;
  reason: string;
  netDelta: number;
  servedDelta: number;
  missedDelta: number;
}

export interface DiagnosticReport {
  archive: RoundArchive;
  drift: string[];
  timeline: TimelineAnalysis;
  losses: LossReport;
  improvements: ImprovementReport[];
  reschedule: RescheduleReport;
  comparison: ComparisonReport | null;
  generatedAt: number;
}

/**
 * 纯函数式诊断：只读归档，不触碰现场 game、新一局或历史最佳。
 * 所有金额均以归档账本（打烊同刻口径）为基准，重演仅用于归因。
 */
export function buildReport(
  archive: RoundArchive,
  allArchives: RoundArchive[],
): DiagnosticReport {
  const { analysis, replay: baseline } = analyzeTimeline(archive);
  const losses = locateLosses(archive, analysis, baseline);
  const improvements = evaluateImprovements(archive);
  const schedule = reschedule(archive);

  const other = findComparable(archive, allArchives);
  let comparison: ComparisonReport | null = null;
  if (other) {
    const comparable = isComparable(other, archive);
    comparison = {
      other,
      comparable,
      reason: comparableReason(other, archive),
      netDelta: archive.net - other.net,
      servedDelta: archive.served - other.served,
      missedDelta: archive.missed - other.missed,
    };
  }

  return {
    archive,
    drift: baseline.drift,
    timeline: analysis,
    losses,
    improvements,
    reschedule: schedule,
    comparison,
    generatedAt: Date.now(),
  };
}
