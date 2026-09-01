// packages/cli/test/init-deploy.test.ts

import { describe, expect, it, vi } from "vitest";
import type { BotConfig } from "@quotient-forecasting/cassie-core";
import {
  commitInitConfig,
  offerInitDeployment,
  type InitDeploymentDependencies,
} from "../src/commands/init.js";

function dependencies(answer: boolean): InitDeploymentDependencies & {
  confirm: ReturnType<typeof vi.fn>;
  deploy: ReturnType<typeof vi.fn>;
  messages: string[];
} {
  const messages: string[] = [];
  return {
    confirm: vi.fn().mockResolvedValue(answer),
    deploy: vi.fn().mockResolvedValue(undefined),
    print: (message) => messages.push(message),
    messages,
  };
}

describe("init deployment handoff", () => {
  it("offers a new DigitalOcean deployment and enters the deploy flow", async () => {
    const deps = dependencies(true);

    await offerInitDeployment("maker", false, deps);

    expect(deps.confirm).toHaveBeenCalledWith("Deploy this bot to a DigitalOcean droplet now?", true);
    expect(deps.deploy).toHaveBeenCalledWith("maker");
    expect(deps.messages.join("\n")).toContain("Runtime");
  });

  it("shows both later runtime choices when deployment is declined", async () => {
    const deps = dependencies(false);

    await offerInitDeployment("maker", false, deps);

    expect(deps.deploy).not.toHaveBeenCalled();
    expect(deps.messages.join("\n")).toContain("cassie run maker");
    expect(deps.messages.join("\n")).toContain("cassie deploy maker");
  });

  it("offers to update an existing deployment without suggesting a parallel local run", async () => {
    const deps = dependencies(false);

    await offerInitDeployment("maker", true, deps);

    expect(deps.confirm).toHaveBeenCalledWith(
      "Apply this configuration to the existing DigitalOcean droplet now?",
      true,
    );
    expect(deps.messages.join("\n")).toContain("cassie deploy maker");
    expect(deps.messages.join("\n")).not.toContain("cassie run maker");
  });
});

describe("init recovery boundary", () => {
  const config = { id: "maker" } as BotConfig;

  it("saves the complete bot before clearing its resumable checkpoint", () => {
    const calls: string[] = [];

    commitInitConfig(config, {
      save: () => calls.push("save"),
      clearCheckpoint: () => calls.push("clear"),
    });

    expect(calls).toEqual(["save", "clear"]);
  });

  it("keeps the checkpoint when the durable config write fails", () => {
    const clearCheckpoint = vi.fn();

    expect(() =>
      commitInitConfig(config, {
        save: () => {
          throw new Error("disk full");
        },
        clearCheckpoint,
      }),
    ).toThrow("disk full");
    expect(clearCheckpoint).not.toHaveBeenCalled();
  });
});
