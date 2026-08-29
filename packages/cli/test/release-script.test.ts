// packages/cli/test/release-script.test.ts
import { describe, expect, it } from "vitest";
import {
  orderWorkspacePackages,
  parseVisibleVersion,
  registryContainsVersion,
} from "../../../scripts/release.mjs";

interface TestPackage {
  name: string;
  version: string;
  path: string;
  manifest: {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}

function pkg(name: string, dependencies: Record<string, string> = {}): TestPackage {
  return { name, version: "0.2.3", path: `/workspace/${name}`, manifest: { dependencies } };
}

describe("release ordering", () => {
  it("publishes strategy dependencies before the runtime and CLI", () => {
    const packages = [
      pkg("@quotient-forecasting/cassie", {
        "@quotient-forecasting/cassie-runtime-node": "workspace:*",
        "@quotient-forecasting/strategy-agent": "workspace:*",
      }),
      pkg("@quotient-forecasting/cassie-runtime-node", {
        "@quotient-forecasting/cassie-core": "workspace:*",
        "@quotient-forecasting/strategy-agent": "workspace:*",
      }),
      pkg("@quotient-forecasting/strategy-agent", {
        "@quotient-forecasting/cassie-core": "workspace:*",
      }),
      pkg("@quotient-forecasting/cassie-core"),
    ];

    expect(orderWorkspacePackages(packages).map((entry) => entry.name)).toEqual([
      "@quotient-forecasting/cassie-core",
      "@quotient-forecasting/strategy-agent",
      "@quotient-forecasting/cassie-runtime-node",
      "@quotient-forecasting/cassie",
    ]);
  });

  it("rejects workspace dependency cycles", () => {
    const packages = [pkg("a", { b: "workspace:*" }), pkg("b", { a: "workspace:*" })];
    expect(() => orderWorkspacePackages(packages)).toThrow("workspace dependency cycle: a -> b -> a");
  });
});

describe("registry version parsing", () => {
  it("accepts npm JSON and plain output", () => {
    expect(parseVisibleVersion('"0.2.3"\n')).toBe("0.2.3");
    expect(parseVisibleVersion("0.2.3\n")).toBe("0.2.3");
  });

  it("detects an accepted version before npm's consumer view has propagated", async () => {
    const requested: string[] = [];
    const fetchImpl = async (input: URL | RequestInfo): Promise<Response> => {
      requested.push(String(input));
      return new Response(JSON.stringify({ versions: { "0.2.3": {} } }), { status: 200 });
    };

    await expect(
      registryContainsVersion(
        "https://registry.npmjs.org/",
        pkg("@quotient-forecasting/strategy-agent"),
        fetchImpl,
      ),
    ).resolves.toBe(true);
    expect(requested[0]).toContain("%40quotient-forecasting%2Fstrategy-agent");
  });

  it("treats a registry 404 as an unpublished package", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("not found", { status: 404 });
    await expect(
      registryContainsVersion("https://registry.npmjs.org/", pkg("new-strategy"), fetchImpl),
    ).resolves.toBe(false);
  });
});
