// packages/core/test/fanout-alerter.test.ts

import { describe, expect, it, vi } from "vitest";
import { FanoutAlerter, SafeAlerter, silentLogger, type Alerter } from "@quotient-forecasting/cassie-core";

describe("FanoutAlerter", () => {
  it("delivers the same alert to every sink", async () => {
    const first = vi.fn<Alerter["send"]>().mockResolvedValue(undefined);
    const second = vi.fn<Alerter["send"]>().mockResolvedValue(undefined);
    const event = { kind: "entry" as const, botId: "bot", message: "entered YES" };

    await new FanoutAlerter([{ send: first }, { send: second }]).send(event);

    expect(first).toHaveBeenCalledExactlyOnceWith(event);
    expect(second).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("keeps other sinks working when a protected sink fails", async () => {
    const failed = vi.fn<Alerter["send"]>().mockRejectedValue(new Error("unavailable"));
    const delivered = vi.fn<Alerter["send"]>().mockResolvedValue(undefined);
    const event = { kind: "exit" as const, botId: "bot", message: "closed YES" };
    const alerter = new FanoutAlerter([
      new SafeAlerter({ send: failed }, silentLogger),
      { send: delivered },
    ]);

    await expect(alerter.send(event)).resolves.toBeUndefined();

    expect(delivered).toHaveBeenCalledExactlyOnceWith(event);
  });
});
