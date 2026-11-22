import type {
  Command,
  Game,
  RoundArchive,
  TranscriptEntry,
} from "../../src/shared/types";
import { createGame } from "../../src/shared/initial";
import { expire, arrive } from "../../src/features/orders/model/orders";
import { applyCommand } from "../../src/features/diagnosis/model/engine";
import { archiveRound } from "../../src/features/diagnosis/model/archive";

function round1(t: number): number {
  return Math.round(t * 10) / 10;
}

/**
 * 命令式测试局：以与现场 session 完全一致的节拍（0.1s tick、来客释放、
 * 打烊同刻可交付）驱动，步骤间可直接查询 game 状态，避免硬编码动态 id。
 */
export class TestRound {
  readonly game: Game;
  private t = 0;

  constructor() {
    this.game = createGame(0);
    this.game.running = true;
  }

  /** 把营业钟推进到指定时刻（含），逐 tick 复现现场的来客与超时结算。 */
  advanceTo(time: number): this {
    const target = round1(time);
    while (this.t < target && this.t < this.game.duration) {
      arrive(this.game);
      this.t = round1(this.t + 0.1);
      this.game.time = this.t;
      expire(this.game);
    }
    return this;
  }

  /** 在当前时刻执行一条指令，并通过统一入口录制流水。 */
  do(command: Command): this {
    const res = applyCommand(this.game, command);
    const entry: TranscriptEntry = {
      seq: this.game.transcript.length,
      time: this.game.time,
      command,
      outcome: res.applied ? "applied" : "rejected",
      reason: res.reason,
    };
    this.game.transcript.push(entry);
    return this;
  }

  /** 推进到某时刻并执行指令。 */
  at(time: number, command: Command): this {
    return this.advanceTo(time).do(command);
  }

  portionId(recipe: string, offset = 0): number {
    const matches = this.game.portions.filter((p) => p.recipe === recipe);
    const p = matches[offset];
    if (!p) throw new Error(`备料台找不到 ${recipe} 的第 ${offset + 1} 份`);
    return p.id;
  }

  finish(): RoundArchive {
    // 跑完剩余营业时长，处理打烊同刻交付
    this.advanceTo(this.game.duration);
    this.game.running = false;
    this.game.ended = true;
    return archiveRound(this.game);
  }
}
