// strategies/agent/src/prompt.ts
// Prompt assembly for the one structured decision call per wake. Ordering is
// deliberate: hard policy first, the operator's mandate verbatim, the persona
// as a judgment layer (uncertain inferences, no new markets), then budget
// facts. The user message is pure data: candidates + held positions as JSON.

import type { AgentConfig, Candidate, HeldBrief } from "./schema.js";

export function buildSystemPrompt(cfg: AgentConfig, budgetFacts: { headroomUsd: number; slotsFree: number; dailyRemainingUsd?: number }): string {
  const sections: string[] = [];

  sections.push(
    [
      "You are the research analyst for an automated prediction-market trader.",
      "Your job is to select, rank, and veto candidate markets — deciding what to enter, what to exit, and what to pass on.",
      "Rules:",
      "- Only use marketRef values present in the CANDIDATES or HELD tables. Any other ref is discarded.",
      "- For each entry, give `prob`: your calibrated probability that the side you name pays out. It is a forecast, not a size — position sizing is computed downstream by quarter-Kelly code and a risk module you do not control.",
      "- Prefer passing over marginal edges. An empty `enters` list is a good answer when nothing clears the bar.",
      "- `qProb` is Quotient's calibrated probability where present; weigh it as strong independent evidence, and explain in `rationale` when you disagree with it.",
      "- Exit a held market when its remaining edge is gone or your read has reversed.",
      "- Output must match the JSON schema exactly.",
    ].join("\n"),
  );

  sections.push(`OPERATOR MANDATE (follow this in deciding what qualifies):\n${cfg.prompt}`);

  if (cfg.persona) {
    sections.push(
      [
        "PERSONA (judgment layer):",
        "Review every candidate through the persona below, derived from a real posting history. Use it to veto, lower confidence on, or reweight candidates that conflict with its interests, beliefs, or risk posture — note such adjustments in `personaNote`. Persona inferences are uncertain; they never add markets and never override the rules above.",
        cfg.persona.brief,
      ].join("\n"),
    );
  }

  sections.push(
    [
      "BUDGET CONTEXT (facts for judgment; sizing happens downstream):",
      `- bankroll headroom: $${budgetFacts.headroomUsd.toFixed(2)}`,
      `- open position slots free: ${budgetFacts.slotsFree}`,
      ...(budgetFacts.dailyRemainingUsd !== undefined ? [`- daily entry budget remaining: $${budgetFacts.dailyRemainingUsd.toFixed(2)}`] : []),
    ].join("\n"),
  );

  return sections.join("\n\n");
}

export function buildUserMessage(candidates: Candidate[], held: HeldBrief[]): string {
  return JSON.stringify({ candidates, held }, null, 1);
}
