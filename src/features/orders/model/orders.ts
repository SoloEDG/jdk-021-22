import type { Game } from "../../../shared/types";
import { activeOrders } from "../lib/patience";
export function accept(g: Game, id: number) {
  const o = g.orders.find((o) => o.id === id);
  if (o?.status !== "waiting") return;
  o.status = "accepted";
  g.selectedOrder = id;
  g.notice = "已接单，请备料并留意客人耐心。";
}
export function expire(g: Game) {
  for (const o of activeOrders(g)) {
    if (g.time >= o.deadline) {
      o.status = "left";
      g.missed++;
      g.combo = 0;
      if (g.selectedOrder === o.id) g.selectedOrder = null;
      g.entries.push({
        id: g.nextId++,
        time: g.time,
        label: `${o.guest} 等待超时`,
        amount: -5,
        kind: "miss",
      });
      g.notice = `${o.guest} 离店，损失 ¥5`;
    }
  }
}
export function arrive(g: Game) {
  if (activeOrders(g).length >= 6) return;
  const due = g.arrivalPlan.filter(
    (a) => Math.round(a.arrived * 10) === Math.round(g.time * 10),
  );
  for (const spec of due) {
    if (g.orders.some((o) => o.id === spec.id)) continue;
    g.orders.push({
      id: spec.id,
      recipe: spec.recipe,
      guest: spec.guest,
      arrived: spec.arrived,
      deadline: spec.deadline,
      status: "waiting",
    });
  }
}
