#!/usr/bin/env node
// packages/cli/src/main.ts
// The installed command also starts the bundled droplet runtime.

if (process.argv[2] === "runtime") {
  process.argv.splice(2, 1);
  await import("@quotient-forecasting/cassie-runtime-node/main");
} else {
  const { runCli } = await import("./index.js");
  await runCli();
}
