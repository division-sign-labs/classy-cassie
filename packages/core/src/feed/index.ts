// packages/core/src/feed/index.ts
// Reporting destinations. `reporting.provider` selects one; runtimes ask for a
// reporter and never name a provider themselves, so adding a destination is a
// case here plus its client — not an edit in every runtime.

import type { ReportingConfig } from "../config.js";
import type { Alerter, Logger } from "../types.js";
import { AresAlerter } from "./ares.js";

export * from "./ares.js";

/** Env var holding each provider's API key, for the message when one is missing. */
export const REPORTING_KEY_ENV: Record<ReportingConfig["provider"], string> = {
  ares: "ARES_API_KEY",
};

export interface BuildReporterOpts {
  reporting?: ReportingConfig;
  /** Provider API key, from env or the keystore. */
  apiKey?: string;
  log: Logger;
}

/**
 * The reporter for a bot's configured destination, or undefined when it reports
 * nowhere.
 *
 * A missing key disables reporting alone — orders keep their builder code, since
 * attribution is a property of the order and does not depend on being able to
 * talk to the provider. That asymmetry is deliberate: losing the key should
 * never silently drop attribution.
 */
export function buildReporter(opts: BuildReporterOpts): Alerter | undefined {
  const { reporting, apiKey, log } = opts;
  if (!reporting?.post) return undefined;

  if (!apiKey) {
    log.warn(
      `reporting.post is on but ${REPORTING_KEY_ENV[reporting.provider]} is unset — ` +
        `orders stay attributed, nothing is reported to ${reporting.provider}`,
    );
    return undefined;
  }

  switch (reporting.provider) {
    case "ares":
      return new AresAlerter({
        apiKey,
        baseUrl: reporting.baseUrl,
        postOn: reporting.postOn,
        log,
      });
    default: {
      // Exhaustive: a new provider in the schema fails to compile until handled.
      const unknown: never = reporting.provider;
      log.warn(`no reporter implemented for provider "${String(unknown)}"`);
      return undefined;
    }
  }
}
