import type { Game, ArrivalSpec } from "./types";

function buildArrivalPlan(): ArrivalSpec[] {
  const list = ["steak", "pasta", "salad"] as const;
  const guests = ["阿宁", "许小姐", "赵先生", "晓晴"];
  const plan: ArrivalSpec[] = [];
  let id = 4;
  for (let seq = 0; seq < 9; seq++) {
    const arrived = (seq + 1) * 18;
    if (arrived >= 150) break;
    plan.push({
      id: id++,
      recipe: list[seq % 3],
      guest: guests[seq % 4],
      arrived,
      deadline: arrived + 60 + (seq % 3) * 5,
    });
  }
  return plan;
}

export function createGame(best = 0): Game {
  return {
    time: 0,
    duration: 180,
    running: false,
    ended: false,
    // 初始订单 1-3、来客计划 4-11；动态 id（备料/菜品/账本）从 12 起，避免与订单撞号
    nextId: 12,
    prepCap: 6,
    dishCap: 8,
    stockCap: 12,
    selectedOrder: null,
    selectedDish: null,
    orders: [
      {
        id: 1,
        recipe: "steak",
        guest: "林小姐",
        arrived: 0,
        deadline: 65,
        status: "waiting",
      },
      {
        id: 2,
        recipe: "pasta",
        guest: "周先生",
        arrived: 0,
        deadline: 75,
        status: "waiting",
      },
      {
        id: 3,
        recipe: "salad",
        guest: "小陈",
        arrived: 0,
        deadline: 55,
        status: "waiting",
      },
    ],
    arrivalPlan: buildArrivalPlan(),
    stock: { beef: 5, noodle: 5, greens: 6 },
    initialStock: { beef: 5, noodle: 5, greens: 6 },
    portions: [],
    stoves: [
      { id: 1, kind: "pan", portion: null, started: 0 },
      { id: 2, kind: "pan", portion: null, started: 0 },
      { id: 3, kind: "pot", portion: null, started: 0 },
    ],
    dishes: [],
    entries: [],
    combo: 0,
    served: 0,
    missed: 0,
    notice: "准备好了吗？开门迎接第一位客人。",
    best,
    transcript: [],
  };
}
