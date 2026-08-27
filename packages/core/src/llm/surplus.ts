// packages/core/src/llm/surplus.ts
// Surplus Intelligence structured-completion client (OpenAI-compatible
// marketplace at api.surplusintelligence.ai). A TypeScript mirror of the
// operator's proven Python client (quotient-analytics-pipelines
// include/helpers/surplus_llm.py); its behaviors are load-bearing:
//
// - Calls prefer the min70 minimum-discount route; when a 4xx body contains
//   "minimum_discount_not_met", the same model pool is retried once through
//   standard /v1 routing.
// - response_format is json_schema with strict:false (local validation stays
//   authoritative across heterogeneous sellers); a 400 whose body mentions
//   "json_schema.strict" retries the same model once with strict:true.
// - Some sellers wrap JSON in a markdown fence despite response_format; only
//   the outer fence is stripped before parsing.
// - Invalid output or a >=400 rotates to the next model in the ordered pool.
//   401/402/403 are hard configuration errors — no rotation.
//
// The strategy layer never computes order sizes from this output; see the
// LLM-numbers policy in thesis/ticket.ts and SKILL.md.

import { z } from "zod";
import { boundFetch } from "../http.js";

export const SURPLUS_DEFAULT_BASE_URL = "https://api.surplusintelligence.ai/min70/v1";
export const SURPLUS_DEFAULT_FALLBACK_BASE_URL = "https://api.surplusintelligence.ai/v1";
export const SURPLUS_DEFAULT_MODEL_POOL = ["gpt-5.6-sol", "glm-5.2", "gemini-3.7-flash"] as const;

export class SurplusConfigurationError extends Error {}

export class SurplusCompletionError extends Error {
  readonly attempts: string[];
  constructor(attempts: string[]) {
    super(`Surplus model pool exhausted: ${attempts.join("; ") || "no models configured"}`);
    this.attempts = attempts;
  }
}

export interface SurplusCompletion<T> {
  parsed: T;
  requestedModel: string;
  actualModel: string;
  promptTokens: number;
  completionTokens: number;
  routingMode: "minimum_discount" | "standard_fallback";
}

export interface SurplusClientOpts {
  apiKey: string;
  baseUrl?: string;
  fallbackBaseUrl?: string;
  modelPool?: readonly string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface StructuredRequest<T> {
  system?: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

/** Remove a Surplus `minN` routing segment while preserving custom hosts. */
export function standardRoutingRoot(preferredRoot: string): string {
  const root = preferredRoot.replace(/\/$/, "");
  return root.replace(/\/min(?:100|[1-9]?[0-9])\/v1$/, "/v1");
}

/** Strip a single outer markdown fence, if present, keeping validation strict otherwise. */
export function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const lines = trimmed.split("\n");
    if (lines.length >= 3) return lines.slice(1, -1).join("\n").trim();
  }
  return trimmed;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return stripOuterFence(content);
  if (Array.isArray(content)) {
    return stripOuterFence(
      content
        .map((part) => (typeof part === "object" && part !== null ? String((part as { text?: unknown }).text ?? "") : ""))
        .join(""),
    );
  }
  if (typeof content === "object" && content !== null) return JSON.stringify(content);
  return stripOuterFence(String(content ?? ""));
}

export class SurplusClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fallbackEndpoint: string | null;
  private readonly fallbackBase: string;
  private readonly modelPool: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SurplusClientOpts) {
    this.apiKey = opts.apiKey.trim();
    if (!this.apiKey) throw new SurplusConfigurationError("a Surplus API key is required");
    const root = (opts.baseUrl ?? SURPLUS_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.endpoint = `${root}/chat/completions`;
    this.fallbackBase = (opts.fallbackBaseUrl ?? standardRoutingRoot(root)).replace(/\/$/, "");
    const fallbackEndpoint = `${this.fallbackBase}/chat/completions`;
    this.fallbackEndpoint = fallbackEndpoint === this.endpoint ? null : fallbackEndpoint;
    this.modelPool = [...new Set((opts.modelPool ?? SURPLUS_DEFAULT_MODEL_POOL).map((m) => m.trim()).filter(Boolean))];
    if (this.modelPool.length === 0) throw new SurplusConfigurationError("the Surplus model pool is empty");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = boundFetch(opts.fetchImpl);
  }

  /**
   * Credential preflight for init/deploy gates: a model-list read on the
   * standard route. 401/402/403 fail as configuration; anything 2xx passes.
   */
  async verify(): Promise<void> {
    const res = await this.fetchImpl(`${this.fallbackBase}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
    });
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new SurplusConfigurationError(`Surplus rejected the API key (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`Surplus verify failed: HTTP ${res.status}`);
  }

  async completeStructured<T>(req: StructuredRequest<T>): Promise<SurplusCompletion<T>> {
    const schemaJson = z.toJSONSchema(req.schema, { target: "draft-7" });
    const schemaName = (req.schemaName ?? "structured_response").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.user },
    ];

    const attempts: string[] = [];
    const routes: Array<["minimum_discount" | "standard_fallback", string]> = [["minimum_discount", this.endpoint]];
    let minimumDiscountUnavailable = false;

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const [routingMode, endpoint] = routes[routeIndex]!;
      for (const requestedModel of this.modelPool) {
        let strictSchema = false;
        for (;;) {
          const attemptName = `${routingMode}/${requestedModel}${strictSchema ? "/strict" : ""}`;
          const payload = {
            model: requestedModel,
            messages,
            temperature: req.temperature ?? 0,
            response_format: {
              type: "json_schema",
              json_schema: { name: schemaName, strict: strictSchema, schema: schemaJson },
            },
            ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
          };

          let res: Response;
          try {
            res = await this.fetchImpl(endpoint, {
              method: "POST",
              headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(this.timeoutMs),
            });
          } catch (err) {
            attempts.push(`${attemptName}: ${(err as Error).message}`);
            break;
          }

          if (res.status === 401 || res.status === 402 || res.status === 403) {
            const detail = (await res.text().catch(() => "")).slice(0, 500);
            throw new SurplusConfigurationError(`Surplus returned HTTP ${res.status}: ${detail}`);
          }
          if (res.status >= 400) {
            const detail = (await res.text().catch(() => "")).slice(0, 500);
            if (res.status === 400 && !strictSchema && detail.includes("json_schema.strict")) {
              strictSchema = true;
              continue;
            }
            if (routingMode === "minimum_discount" && detail.includes("minimum_discount_not_met")) {
              minimumDiscountUnavailable = true;
            }
            attempts.push(`${attemptName}: HTTP ${res.status}: ${detail}`);
            break;
          }

          const completion = await this.parseCompletion(res, req.schema, requestedModel, routingMode, attemptName, attempts);
          if (completion) return completion;
          break;
        }
      }
      if (routeIndex === 0 && minimumDiscountUnavailable && this.fallbackEndpoint !== null) {
        routes.push(["standard_fallback", this.fallbackEndpoint]);
      }
    }
    throw new SurplusCompletionError(attempts);
  }

  private async parseCompletion<T>(
    res: Response,
    schema: z.ZodType<T>,
    requestedModel: string,
    routingMode: "minimum_discount" | "standard_fallback",
    attemptName: string,
    attempts: string[],
  ): Promise<SurplusCompletion<T> | null> {
    try {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; input_tokens?: number; completion_tokens?: number; output_tokens?: number };
        model?: string;
      };
      const text = contentText(data.choices?.[0]?.message?.content);
      const parsed = schema.parse(JSON.parse(text));
      return {
        parsed,
        requestedModel,
        actualModel: String(data.model ?? requestedModel),
        promptTokens: Number(data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0),
        completionTokens: Number(data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0),
        routingMode,
      };
    } catch (err) {
      attempts.push(`${attemptName}: invalid structured response: ${(err as Error).message.slice(0, 200)}`);
      return null;
    }
  }
}
