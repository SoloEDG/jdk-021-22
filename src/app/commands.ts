import type { Game, Command } from "../shared/types";
import { applyCommand } from "../features/diagnosis/model/engine";
export function dispatch(g: Game, c: Command) {
  const result = applyCommand(g, c);
  g.transcript.push({
    seq: g.transcript.length,
    time: g.time,
    command: c,
    outcome: result.applied ? "applied" : "rejected",
    reason: result.reason,
  });
}
