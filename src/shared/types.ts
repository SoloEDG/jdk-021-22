export type RecipeId = "steak" | "pasta" | "salad";
export type Ingredient = "beef" | "noodle" | "greens";
export interface Recipe {
  id: RecipeId;
  name: string;
  icon: string;
  ingredient: Ingredient;
  station: "pan" | "pot";
  target: number;
  price: number;
}
export interface Order {
  id: number;
  recipe: RecipeId;
  guest: string;
  arrived: number;
  deadline: number;
  status: "waiting" | "accepted" | "served" | "left";
}
export interface Portion {
  id: number;
  recipe: RecipeId;
  preparedAt: number;
}
export interface Stove {
  id: number;
  kind: "pan" | "pot";
  portion: Portion | null;
  started: number;
}
export interface Dish {
  id: number;
  recipe: RecipeId;
  quality: number;
  cookedAt: number;
  stage: "counter" | "plated";
}
export interface Entry {
  id: number;
  time: number;
  label: string;
  amount: number;
  kind: "sale" | "waste" | "miss" | "supply";
}
export type TranscriptOutcome = "applied" | "rejected";
export interface TranscriptEntry {
  seq: number;
  time: number;
  command: Command;
  outcome: TranscriptOutcome;
  reason: string;
}
export interface ArrivalSpec {
  id: number;
  recipe: RecipeId;
  guest: string;
  arrived: number;
  deadline: number;
}
export interface RoundConfig {
  duration: number;
  prepCap: number;
  dishCap: number;
  stockCap: number;
  initialStock: Record<Ingredient, number>;
  stoves: { id: number; kind: "pan" | "pot" }[];
  recipes: {
    id: RecipeId;
    name: string;
    ingredient: Ingredient;
    station: "pan" | "pot";
    target: number;
    price: number;
  }[];
  arrivals: ArrivalSpec[];
}
export interface RoundArchive {
  id: string;
  endedAt: number;
  config: RoundConfig;
  configKey: string;
  flowKey: string;
  transcript: TranscriptEntry[];
  ledger: Entry[];
  net: number;
  sales: number;
  cost: number;
  served: number;
  missed: number;
  grade: string;
}
export interface Game {
  time: number;
  duration: number;
  running: boolean;
  ended: boolean;
  nextId: number;
  prepCap: number;
  dishCap: number;
  stockCap: number;
  selectedOrder: number | null;
  selectedDish: number | null;
  orders: Order[];
  arrivalPlan: ArrivalSpec[];
  stock: Record<Ingredient, number>;
  initialStock: Record<Ingredient, number>;
  portions: Portion[];
  stoves: Stove[];
  dishes: Dish[];
  entries: Entry[];
  combo: number;
  served: number;
  missed: number;
  notice: string;
  best: number;
  transcript: TranscriptEntry[];
}
export type Command =
  | { type: "accept"; id: number }
  | { type: "select-order"; id: number }
  | { type: "prepare"; recipe: RecipeId }
  | { type: "cook"; portion: number; stove: number }
  | { type: "lift"; id: number }
  | { type: "plate"; id: number }
  | { type: "select-dish"; id: number }
  | { type: "serve" }
  | { type: "discard"; id: number }
  | { type: "restock"; ingredient: Ingredient };
