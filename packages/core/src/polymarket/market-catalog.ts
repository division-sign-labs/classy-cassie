// packages/core/src/polymarket/market-catalog.ts
// Strict Gamma metadata lookup for the market-make runtime. Identity is
// validated against Quotient and outcome tokens are mapped by label, never by
// array position alone.

import { z } from "zod";
import { boundFetch } from "../http.js";

const StringOrNumber = z.union([z.string(), z.number()]);
const StringArray = z.union([z.array(z.string()), z.string()]);

const GammaEventSchema = z
  .object({
    id: StringOrNumber,
    category: z.string().nullish(),
  })
  .loose();

const GammaMarketSchema = z
  .object({
    id: StringOrNumber,
    conditionId: z.string(),
    question: z.string().nullish(),
    outcomes: StringArray,
    clobTokenIds: StringArray,
    active: z.boolean().nullish(),
    closed: z.boolean().nullish(),
    archived: z.boolean().nullish(),
    acceptingOrders: z.boolean().nullish(),
    enableOrderBook: z.boolean().nullish(),
    orderbookEnabled: z.boolean().nullish(),
    endDate: z.string().nullish(),
    volume24hr: StringOrNumber.nullish(),
    orderPriceMinTickSize: StringOrNumber.nullish(),
    orderMinSize: StringOrNumber.nullish(),
    category: z.string().nullish(),
    negRiskMarketID: StringOrNumber.nullish(),
    events: z.array(GammaEventSchema).nullish(),
  })
  .loose();

export interface PolymarketMarketCatalog {
  marketKey: string;
  nativeMarketId: string;
  conditionId: string;
  marketRef: string;
  question?: string;
  eventId: string;
  category: string;
  manualCorrelationGroup?: string;
  yesTokenId: string;
  noTokenId: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  orderbookEnabled: boolean;
  endsAt: number;
  volume24hUsd: number;
  tickSize: number;
  minOrderSize: number;
}

export interface PolymarketCatalogRecoveryIdentity {
  conditionId?: string;
  clobTokenId?: string;
}

export interface PolymarketCatalogRecovery {
  marketKey: string;
  nativeMarketId: string;
  catalog: PolymarketMarketCatalog;
}

function stringList(label: string, raw: string[] | string): string[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`Gamma ${label} is not valid JSON`);
    }
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Gamma ${label} must be a non-empty string array`);
  }
  return value.map((entry) => entry.trim());
}

function finitePositive(label: string, raw: string | number | null | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Gamma ${label} must be a positive number`);
  return value;
}

function finiteNonnegative(label: string, raw: string | number | null | undefined): number {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Gamma ${label} must be a non-negative number`);
  return value;
}

export function normalizePolymarketCatalog(
  marketKey: string,
  expectedNativeMarketId: string,
  expectedConditionId: string,
  raw: unknown,
): PolymarketMarketCatalog {
  const row = GammaMarketSchema.parse(raw);
  const nativeMarketId = String(row.id);
  if (nativeMarketId !== expectedNativeMarketId) {
    throw new Error(`Gamma market id ${nativeMarketId} does not match Quotient ${expectedNativeMarketId}`);
  }
  if (marketKey !== `polymarket:${nativeMarketId}`) {
    throw new Error(`marketKey ${marketKey} does not match Gamma market ${nativeMarketId}`);
  }
  if (row.conditionId.toLowerCase() !== expectedConditionId.toLowerCase()) {
    throw new Error(`Gamma condition ${row.conditionId} does not match Quotient ${expectedConditionId}`);
  }

  const outcomes = stringList("outcomes", row.outcomes);
  const tokens = stringList("clobTokenIds", row.clobTokenIds);
  if (outcomes.length !== tokens.length) throw new Error("Gamma outcome/token arrays have different lengths");
  if (outcomes.length !== 2) throw new Error("Gamma market must contain exactly two outcome tokens");
  const mapped = new Map(outcomes.map((outcome, index) => [outcome.toUpperCase(), tokens[index]!]));
  const yesTokenId = mapped.get("YES");
  const noTokenId = mapped.get("NO");
  if (mapped.size !== 2 || !yesTokenId || !noTokenId || yesTokenId === noTokenId) {
    throw new Error("Gamma market must contain distinct, explicitly labeled YES and NO tokens");
  }

  const event = row.events?.[0];
  if (!event) throw new Error("Gamma market has no parent event identity");
  const end = Date.parse(row.endDate ?? "");
  if (!Number.isFinite(end)) throw new Error("Gamma endDate is missing or invalid");
  const category = (row.category ?? event.category ?? "").trim();

  return {
    marketKey,
    nativeMarketId,
    conditionId: row.conditionId,
    marketRef: yesTokenId,
    ...(row.question ? { question: row.question } : {}),
    eventId: `polymarket:${String(event.id)}`,
    category,
    ...(row.negRiskMarketID === null || row.negRiskMarketID === undefined
      ? {}
      : { manualCorrelationGroup: `polymarket-neg-risk:${String(row.negRiskMarketID)}` }),
    yesTokenId,
    noTokenId,
    active: row.active === true,
    closed: row.closed === true,
    archived: row.archived === true,
    acceptingOrders: row.acceptingOrders === true,
    orderbookEnabled: (row.enableOrderBook ?? row.orderbookEnabled) === true,
    endsAt: end,
    volume24hUsd: finiteNonnegative("volume24hr", row.volume24hr),
    tickSize: finitePositive("orderPriceMinTickSize", row.orderPriceMinTickSize),
    minOrderSize: finitePositive("orderMinSize", row.orderMinSize),
  };
}

export interface PolymarketCatalogClientOptions {
  gammaBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export class PolymarketCatalogClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: PolymarketCatalogClientOptions) {
    this.#baseUrl = options.gammaBaseUrl.replace(/\/$/, "");
    this.#fetch = boundFetch(options.fetchImpl);
  }

  /**
   * Query by exact id through the list form. `/markets/{id}` serves a response
   * shape that omits `events`, so the parent event identity every catalog row
   * requires is only reachable through `/markets?id={id}`.
   */
  async market(
    marketKey: string,
    nativeMarketId: string,
    expectedConditionId: string,
  ): Promise<PolymarketMarketCatalog> {
    const url = new URL(`${this.#baseUrl}/markets`);
    url.searchParams.set("id", nativeMarketId);
    const response = await this.#fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Gamma market ${nativeMarketId} → ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error(`Gamma market ${nativeMarketId} returned a non-array response`);
    if (body.length !== 1) {
      throw new Error(`Gamma market ${nativeMarketId} expected exactly one result, received ${body.length}`);
    }
    return normalizePolymarketCatalog(marketKey, nativeMarketId, expectedConditionId, body[0]);
  }

  /**
   * Recover canonical Gamma identity for venue inventory that was not already
   * present in reducer state. Each supplied identifier is queried separately:
   * this makes a condition/token disagreement observable instead of relying on
   * undocumented intersection semantics for multiple Gamma filters.
   */
  async recover(identity: PolymarketCatalogRecoveryIdentity): Promise<PolymarketCatalogRecovery> {
    const conditionId = optionalIdentity("conditionId", identity.conditionId);
    const clobTokenId = optionalIdentity("clobTokenId", identity.clobTokenId);
    if (!conditionId && !clobTokenId) {
      throw new Error("Gamma catalog recovery requires a conditionId or clobTokenId");
    }

    const [conditionRow, tokenRow] = await Promise.all([
      conditionId ? this.#queryOne("condition_ids", conditionId) : undefined,
      clobTokenId ? this.#queryOne("clob_token_ids", clobTokenId) : undefined,
    ]);
    const conditionCatalog = conditionRow ? recoveryCatalog(conditionRow) : undefined;
    const tokenCatalog = tokenRow ? recoveryCatalog(tokenRow) : undefined;

    if (conditionCatalog && conditionCatalog.conditionId.toLowerCase() !== conditionId!.toLowerCase()) {
      throw new Error(
        `Gamma condition query returned ${conditionCatalog.conditionId}, expected exact condition ${conditionId}`,
      );
    }
    if (
      tokenCatalog &&
      tokenCatalog.yesTokenId !== clobTokenId &&
      tokenCatalog.noTokenId !== clobTokenId
    ) {
      throw new Error(`Gamma token query did not return exact token ${clobTokenId}`);
    }
    if (conditionCatalog && tokenCatalog && !sameRecoveryIdentity(conditionCatalog, tokenCatalog)) {
      throw new Error(
        `Gamma recovery identifiers conflict: condition ${conditionId} resolved to ${conditionCatalog.marketKey}, ` +
        `token ${clobTokenId} resolved to ${tokenCatalog.marketKey}`,
      );
    }

    const catalog = conditionCatalog ?? tokenCatalog!;
    return {
      marketKey: catalog.marketKey,
      nativeMarketId: catalog.nativeMarketId,
      catalog,
    };
  }

  async #queryOne(filter: "condition_ids" | "clob_token_ids", value: string): Promise<unknown> {
    const url = new URL(`${this.#baseUrl}/markets`);
    url.searchParams.set(filter, value);
    const response = await this.#fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Gamma market recovery by ${filter} → ${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error(`Gamma market recovery by ${filter} returned a non-array response`);
    if (body.length !== 1) {
      throw new Error(`Gamma market recovery by ${filter} expected exactly one result, received ${body.length}`);
    }
    return body[0];
  }
}

function optionalIdentity(label: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw new Error(`Gamma catalog recovery ${label} must not be empty`);
  return value;
}

function recoveryCatalog(raw: unknown): PolymarketMarketCatalog {
  const row = GammaMarketSchema.parse(raw);
  const nativeMarketId = String(row.id);
  return normalizePolymarketCatalog(
    `polymarket:${nativeMarketId}`,
    nativeMarketId,
    row.conditionId,
    row,
  );
}

function sameRecoveryIdentity(a: PolymarketMarketCatalog, b: PolymarketMarketCatalog): boolean {
  return a.marketKey === b.marketKey &&
    a.nativeMarketId === b.nativeMarketId &&
    a.conditionId.toLowerCase() === b.conditionId.toLowerCase() &&
    a.yesTokenId === b.yesTokenId &&
    a.noTokenId === b.noTokenId;
}
