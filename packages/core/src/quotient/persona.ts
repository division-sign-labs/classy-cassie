// packages/core/src/quotient/persona.ts
// Persona brief rendering. The Quotient X-profile response is rich enough to
// distill deterministically — no LLM call is spent on it. The rendered brief
// is stored in the bot's strategy config (it is not a secret) and injected
// into the agent's system prompt as a judgment layer; profile inferences are
// framed as uncertain there, never as hard rules.

import { z } from "zod";

const StringishSchema = z.union([z.string(), z.array(z.string())]);

/** Lenient: any of these may be absent, a string, or a list of strings. */
export const PersonaProfileSchema = z
  .object({
    handle: z.string().nullish(),
    summary: StringishSchema.nullish(),
    interests: StringishSchema.nullish(),
    beliefs: StringishSchema.nullish(),
    tendencies: StringishSchema.nullish(),
    risk_profile: StringishSchema.nullish(),
    information_processing: StringishSchema.nullish(),
    recommendation_hints: StringishSchema.nullish(),
    confidence: z.union([z.string(), z.number()]).nullish(),
  })
  .loose();
export type PersonaProfile = z.output<typeof PersonaProfileSchema>;

const MAX_BRIEF_CHARS = 4_000;

function lines(value: z.output<typeof StringishSchema> | null | undefined): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((s) => s.trim()).filter(Boolean);
}

function section(title: string, value: z.output<typeof StringishSchema> | null | undefined): string[] {
  const items = lines(value);
  if (items.length === 0) return [];
  return [`${title}:`, ...items.map((item) => `- ${item}`)];
}

/**
 * Deterministic template over the profile fields (~1.5 KB typical). The same
 * profile always renders the same brief, so a stored persona is stable across
 * wakes and redeploys until the operator refreshes it.
 */
export function renderPersonaBrief(profileJson: unknown): string {
  const parsed = PersonaProfileSchema.safeParse(profileJson);
  if (!parsed.success) throw new Error("persona profile has an unrecognized shape");
  const p = parsed.data;
  const out = [
    ...(p.handle ? [`Persona derived from the posting history of @${p.handle.replace(/^@/, "")}.`] : []),
    ...section("Summary", p.summary),
    ...section("Interests", p.interests),
    ...section("Beliefs", p.beliefs),
    ...section("Tendencies", p.tendencies),
    ...section("Risk posture", p.risk_profile),
    ...section("Information style", p.information_processing),
    ...section("Recommendation hints", p.recommendation_hints),
    ...(p.confidence != null ? [`Profile confidence: ${p.confidence}`] : []),
  ].join("\n");
  if (!out.trim()) throw new Error("persona profile rendered an empty brief");
  return out.length > MAX_BRIEF_CHARS ? `${out.slice(0, MAX_BRIEF_CHARS - 1)}…` : out;
}
