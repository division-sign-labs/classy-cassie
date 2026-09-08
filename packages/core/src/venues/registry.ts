// packages/core/src/venues/registry.ts
// Venue adapter factory. Runtimes construct adapters through this so a
// strategy run on a different venue is a config change, not a code change (§8).

import type { RuntimeCreds, VenueAdapter, VenueId } from "../types.js";
import type { VenueUrls } from "../config.js";
import type { PolymarketGaslessAuth } from "../polymarket/gasless-auth.js";
import { FixtureVenue, type BooksFixture } from "./fixture.js";

export interface AdapterOpts {
  urls: VenueUrls;
  /** Runtime-eligible creds; read-only flows (setup/wizard) may omit them. */
  creds?: RuntimeCreds;
  /** Operator-authorized gasless service credential, separate from trading keys. */
  polymarketGaslessAuth?: PolymarketGaslessAuth;
  /** Fixture venue only: books fixture JSON (string or parsed). */
  fixtureBooks?: string | BooksFixture;
  /** Selected HIP-3 DEX for explicitly scoped strategy accounts. */
  perpDex?: string;
}

export type AdapterFactory = (opts: AdapterOpts) => VenueAdapter;

const factories = new Map<VenueId, AdapterFactory>();

/** Adapters self-register (or runtimes register) their factory here. */
export function registerAdapter(venue: VenueId, factory: AdapterFactory): void {
  factories.set(venue, factory);
}

export function createAdapter(venue: VenueId, opts: AdapterOpts): VenueAdapter {
  if (venue === "fixture") {
    if (!opts.fixtureBooks) throw new Error("fixture venue requires fixtureBooks");
    return new FixtureVenue(opts.fixtureBooks);
  }
  const factory = factories.get(venue);
  if (!factory) {
    throw new Error(`no adapter registered for venue "${venue}" — import its module first`);
  }
  return factory(opts);
}
