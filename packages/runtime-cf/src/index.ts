// packages/runtime-cf/src/index.ts
// Stable Wrangler entrypoint; the implementation lives beside it so the
// Worker-to-Container migration could first deploy a legacy shutdown bridge.

export { BotAgent, ContainerProxy, default } from "./container.js";
