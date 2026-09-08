// packages/runtime-node/test/swing-shutdown.test.ts
import { describe, expect, it, vi } from "vitest";
import { BotService } from "../src/service.js";

function fixture() {
  const prepareShutdown = vi.fn(async () => {}), shutdown = vi.fn(async () => {}), close = vi.fn(), stopTimers = vi.fn();
  // Only exercise the service lifecycle boundary; no adapters, sockets, keys or timers are constructed.
  const service: BotService = Object.assign(Object.create(BotService.prototype) as BotService, {
    swing: { config: { mode: "live" }, prepareShutdown, shutdown }, state: { close }, operation: Promise.resolve(),
    active: true, terminating: false, stopTimers,
  });
  return { service, prepareShutdown, shutdown, close, stopTimers };
}
describe("swing shutdown keeps protection alive on uncertainty", () => {
  it("keeps the service running and state open if cancellation/protection is not proven", async () => {
    const f = fixture(); f.prepareShutdown.mockRejectedValueOnce(new Error("entry acknowledgement remains unknown"));
    await expect(f.service.shutdown(true)).rejects.toThrow("acknowledgement remains unknown");
    expect(f.service.running).toBe(true);
    expect(f.stopTimers).not.toHaveBeenCalled(); expect(f.shutdown).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
    await expect(f.service.shutdown(true)).resolves.toMatchObject({ stopped: true, restingOrdersCanceled: true });
    expect(f.prepareShutdown).toHaveBeenCalledTimes(2);
    expect(f.service.running).toBe(false); expect(f.close).toHaveBeenCalledOnce();
  });
  it("does not close stores or stop supervision while the preflight is pending", async () => {
    const f = fixture(); let release!: () => void;
    f.prepareShutdown.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = f.service.shutdown(); await Promise.resolve();
    expect(f.service.running).toBe(true); expect(f.close).not.toHaveBeenCalled();
    expect(f.service.shutdown()).toBe(pending);
    release(); await pending;
    expect(f.stopTimers).toHaveBeenCalledOnce(); expect(f.shutdown).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("cannot skip protection checks for an active live bot with cancelResting=false", async () => {
    const f = fixture(); await f.service.shutdown(false);
    expect(f.prepareShutdown).toHaveBeenCalledOnce();
  });
});
