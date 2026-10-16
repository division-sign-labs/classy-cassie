// packages/cli/src/signal-categories.ts
import { ExcludedSignalCategoriesSchema } from "@quotient-forecasting/cassie-core";
import { ask, select } from "./context.js";

export function parseExcludedCategories(raw: string): string[] {
  if (raw.trim().toLowerCase() === "none") return [];
  const parsed = ExcludedSignalCategoriesSchema.safeParse(raw.split(","));
  if (!parsed.success) throw new Error("Enter category names separated by commas, or none to enable all categories.");
  return parsed.data;
}

export function setSportsSignals(categories: string[], enabled: boolean): string[] {
  const others = categories.filter(category => category !== "sports");
  return enabled ? others : [...others, "sports"];
}

export async function elicitSignalCategories(current: unknown, otherCategories = true): Promise<string[]> {
  let excluded = ExcludedSignalCategoriesSchema.parse(current);
  const choices = [
    { value: "on", title: "On", description: "Include sports signals" },
    { value: "off", title: "Off", description: "Skip new sports entries and top-ups" },
  ];
  if (excluded.includes("sports")) choices.reverse();
  const sports = await select("Sports signals", choices);
  if (otherCategories) {
    excluded = parseExcludedCategories(await ask("Other excluded categories (comma-separated or none)", {
      default: excluded.filter(category => category !== "sports").join(", ") || "none",
    }));
  }
  return setSportsSignals(excluded, sports === "on");
}
