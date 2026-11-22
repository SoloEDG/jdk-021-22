import type { Command, Game } from "../../../shared/types";
import { recipes } from "../../../shared/catalog";
import { accept, expire } from "../../orders/model/orders";
import { prepare, restock } from "../../pantry/model/inventory";
import { cook, lift } from "../../kitchen/model/cooking";
import { plate, discard } from "../../service/model/plating";
import { deliver } from "../../service/model/delivery";
import { preparationIssue, restockIssue } from "../../pantry/lib/availability";
import { servicePair } from "../../service/lib/freshness";

/**
 * 指令守卫：返回空串表示指令当前可执行（或属于“执行但带惩罚”的分支），
 * 否则返回不可执行的原因。现场与无头重演共用同一判定，保证跳过逻辑一致。
 */
export function checkCommand(g: Game, c: Command): string {
  switch (c.type) {
    case "accept": {
      const o = g.orders.find((x) => x.id === c.id);
      return o?.status === "waiting" ? "" : "订单已不在等待状态，接单指令跳过";
    }
    case "select-order":
      return g.orders.some((o) => o.id === c.id && o.status === "accepted")
        ? ""
        : "没有可选择的已接订单";
    case "prepare":
      return preparationIssue(g, c.recipe);
    case "restock":
      return restockIssue(g, c.ingredient);
    case "cook": {
      const p = g.portions.find((x) => x.id === c.portion);
      const s = g.stoves.find((x) => x.id === c.stove);
      if (!p) return "备料已不存在，下锅指令跳过";
      if (!s) return "灶台不存在，下锅指令跳过";
      if (s.portion) return "灶台已被占用，下锅指令跳过";
      if (recipes[p.recipe].station !== s.kind)
        return "设备不匹配：意面用汤锅，牛排和沙拉用煎锅";
      return "";
    }
    case "lift": {
      const s = g.stoves.find((x) => x.id === c.id);
      if (!s?.portion) return "灶台上没有在烹菜品，起锅指令跳过";
      if (g.dishes.length >= g.dishCap)
        return `出餐台已满（${g.dishCap}份），起锅指令跳过`;
      return "";
    }
    case "plate": {
      const d = g.dishes.find((x) => x.id === c.id);
      return d && d.stage === "counter" ? "" : "没有待装盘的菜品，装盘指令跳过";
    }
    case "select-dish":
      return g.dishes.some((d) => d.id === c.id && d.stage === "plated")
        ? ""
        : "没有可选择的已装盘菜品";
    case "serve": {
      const { dish, order } = servicePair(g);
      if (!dish || dish.stage !== "plated" || !order)
        return "请选择已装盘菜品和已接订单";
      // 错菜与品质拒收属于“执行成功但带惩罚”，由 deliver 结算，不算跳过
      return "";
    }
    case "discard":
      return g.dishes.some((d) => d.id === c.id) ? "" : "菜品已不在出餐台，丢弃指令跳过";
    default:
      return "未知指令，跳过";
  }
}

export interface ApplyResult {
  applied: boolean;
  reason: string;
}

/** 现场与重演共用的指令执行入口；serve 后与现场 dispatch 一致补一次超时检查。 */
export function applyCommand(g: Game, c: Command): ApplyResult {
  if (!g.running || g.ended) {
    return { applied: false, reason: "营业未进行中，指令不生效" };
  }
  const reason = checkCommand(g, c);
  if (reason) {
    g.notice = reason;
    return { applied: false, reason };
  }
  switch (c.type) {
    case "accept":
      accept(g, c.id);
      break;
    case "select-order":
      g.selectedOrder = c.id;
      break;
    case "prepare":
      prepare(g, c.recipe);
      break;
    case "restock":
      restock(g, c.ingredient);
      break;
    case "cook":
      cook(g, c.portion, c.stove);
      break;
    case "lift":
      lift(g, c.id);
      break;
    case "plate":
      plate(g, c.id);
      break;
    case "select-dish":
      g.selectedDish = c.id;
      break;
    case "serve":
      deliver(g);
      expire(g);
      break;
    case "discard":
      discard(g, c.id);
      break;
  }
  return { applied: true, reason: "" };
}
