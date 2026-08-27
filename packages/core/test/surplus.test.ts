// packages/core/test/surplus.test.ts
// SurplusClient behaviors mirrored from the operator's proven Python client:
// structured parsing, fence-stripping, model-pool rotation, the strict-schema
// retry, the min70 → /v1 fallback, and hard configuration errors.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SurplusClient,
  SurplusCompletionError,
  SurplusConfigurationError,
  standardRoutingRoot,
  stripOuterFence,
} from "@quotient-forecasting/cassie-core";

const Schema = z.object({ answer: z.string() });

interface Call {
  url: string;
  body: { model: string; response_format: { json_schema: { strict: boolean } } };
}

function scriptedFetch(script: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : ({} as Call["body"]) });
    return Promise.resolve(
      new Response(JSON.stringify(step.body), { status: step.status, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

function ok(content: string, model = "gpt-5.6-sol") {
  return { status: 200, body: { model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } };
}

function client(impl: typeof fetch, pool = ["gpt-5.6-sol", "glm-5.2"]) {
  return new SurplusClient({ apiKey: "inf_test", modelPool: pool, fetchImpl: impl });
}

describe("routing root", () => {
  it("strips a minN segment and preserves custom hosts", () => {
    expect(standardRoutingRoot("https://api.surplusintelligence.ai/min70/v1")).toBe("https://api.surplusintelligence.ai/v1");
    expect(standardRoutingRoot("https://example.com/v1")).toBe("https://example.com/v1");
  });
});

describe("completeStructured", () => {
  it("parses a valid structured completion with usage and model", async () => {
    const { impl, calls } = scriptedFetch([ok('{"answer":"pong"}')]);
    const res = await client(impl).completeStructured({ user: "ping", schema: Schema });
    expect(res.parsed).toEqual({ answer: "pong" });
    expect(res).toMatchObject({ requestedModel: "gpt-5.6-sol", actualModel: "gpt-5.6-sol", promptTokens: 10, completionTokens: 5, routingMode: "minimum_discount" });
    expect(calls[0]!.url).toBe("https://api.surplusintelligence.ai/min70/v1/chat/completions");
    expect(calls[0]!.body.response_format.json_schema.strict).toBe(false);
  });

  it("strips an outer markdown fence before parsing", async () => {
    const { impl } = scriptedFetch([ok('```json\n{"answer":"fenced"}\n```')]);
    const res = await client(impl).completeStructured({ user: "u", schema: Schema });
    expect(res.parsed.answer).toBe("fenced");
    expect(stripOuterFence("```\n{}\n```")).toBe("{}");
  });

  it("rotates to the next model on invalid JSON output", async () => {
    const { impl, calls } = scriptedFetch([ok("not json at all"), ok('{"answer":"second"}', "glm-5.2")]);
    const res = await client(impl).completeStructured({ user: "u", schema: Schema });
    expect(res.parsed.answer).toBe("second");
    expect(res.requestedModel).toBe("glm-5.2");
    expect(calls.map((c) => c.body.model)).toEqual(["gpt-5.6-sol", "glm-5.2"]);
  });

  it("retries the same model once with strict:true when the seller demands it", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 400, body: { error: "response_format json_schema.strict must be true" } },
      ok('{"answer":"strict"}'),
    ]);
    const res = await client(impl).completeStructured({ user: "u", schema: Schema });
    expect(res.parsed.answer).toBe("strict");
    expect(calls[0]!.body.response_format.json_schema.strict).toBe(false);
    expect(calls[1]!.body).toMatchObject({ model: "gpt-5.6-sol", response_format: { json_schema: { strict: true } } });
  });

  it("falls back to /v1 when the min70 route reports minimum_discount_not_met", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 409, body: { error: { code: "minimum_discount_not_met" } } },
      { status: 409, body: { error: { code: "minimum_discount_not_met" } } },
      ok('{"answer":"fallback"}'),
    ]);
    const res = await client(impl).completeStructured({ user: "u", schema: Schema });
    expect(res.parsed.answer).toBe("fallback");
    expect(res.routingMode).toBe("standard_fallback");
    expect(calls[2]!.url).toBe("https://api.surplusintelligence.ai/v1/chat/completions");
  });

  it("402 is a hard configuration error — no rotation", async () => {
    const { impl, calls } = scriptedFetch([{ status: 402, body: { error: "payment required" } }]);
    await expect(client(impl).completeStructured({ user: "u", schema: Schema })).rejects.toBeInstanceOf(SurplusConfigurationError);
    expect(calls).toHaveLength(1);
  });

  it("exhausting the pool throws with the attempts trail", async () => {
    const { impl } = scriptedFetch([{ status: 500, body: { error: "boom" } }]);
    const err = await client(impl)
      .completeStructured({ user: "u", schema: Schema })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SurplusCompletionError);
    const attempts = (err as SurplusCompletionError).attempts;
    expect(attempts.some((a) => a.includes("minimum_discount/gpt-5.6-sol"))).toBe(true);
    expect(attempts.some((a) => a.includes("minimum_discount/glm-5.2"))).toBe(true);
  });
});

describe("verify", () => {
  it("passes on 2xx from the standard route and fails hard on 401", async () => {
    const okFetch = scriptedFetch([{ status: 200, body: { data: [] } }]);
    await expect(client(okFetch.impl).verify()).resolves.toBeUndefined();
    expect(okFetch.calls[0]!.url).toBe("https://api.surplusintelligence.ai/v1/models");

    const badFetch = scriptedFetch([{ status: 401, body: {} }]);
    await expect(client(badFetch.impl).verify()).rejects.toBeInstanceOf(SurplusConfigurationError);
  });
});
