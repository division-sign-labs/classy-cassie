// packages/core/src/signals/categories.ts
// Category preferences gate entries; held-market forecasts remain available for exits.
import { z } from "zod";
import type { Signal } from "../types.js";

export function normalizeSignalCategory(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export const ExcludedSignalCategoriesSchema = z.array(
  z.string().transform(normalizeSignalCategory).pipe(z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use category names separated by commas")),
).default([]).transform(categories => [...new Set(categories)]);

/** Match the published sleeve or its broader group, with sports metadata as a fallback. */
export function excludedSignalCategory(
  signal: Pick<Signal, "sleeve" | "sleeveGroup" | "sports">,
  excluded: readonly string[],
): string | undefined {
  const categories = [signal.sleeve, signal.sleeveGroup, ...(signal.sports ? ["sports"] : [])]
    .filter((value): value is string => Boolean(value)).map(normalizeSignalCategory);
  return excluded.find(category => categories.includes(category));
}
