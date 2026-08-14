// packages/cli/test/wrangler.test.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeWorkerWranglerProject } from "../src/wrangler.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cassie-wrangler-test-"));
  roots.push(root);
  return root;
}

describe("materializeWorkerWranglerProject", () => {
  it("gives each Worker its own container app and preserves paths after moving the config", () => {
    const root = tempRoot();
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    const sourceConfig = join(runtime, "wrangler.jsonc");
    writeFileSync(
      sourceConfig,
      `// contributor config
      {
        "$schema": "./node_modules/wrangler/config-schema.json",
        "name": "cassie-bot-unconfigured",
        "main": "src/index.ts",
        "containers": [{
          "name": "cassie-runtime",
          "class_name": "BotAgent",
          "image": "./Dockerfile",
          "image_build_context": "../..",
        }],
      }
      `,
    );

    const materialized = materializeWorkerWranglerProject(
      { cwd: runtime, config: "wrangler.jsonc" },
      "cassie-bot-alpha",
    );
    const temporaryConfig = materialized.project.config!;
    try {
      const config = JSON.parse(readFileSync(temporaryConfig, "utf8")) as {
        $schema?: string;
        name: string;
        main: string;
        containers: { name: string; image: string; image_build_context: string }[];
      };
      expect(materialized.project.cwd).toBe(resolve(runtime));
      expect(config.$schema).toBeUndefined();
      expect(config.name).toBe("cassie-bot-alpha");
      expect(config.main).toBe(join(runtime, "src/index.ts"));
      expect(config.containers).toEqual([
        expect.objectContaining({
          name: "cassie-bot-alpha",
          image: join(runtime, "Dockerfile"),
          image_build_context: resolve(runtime, "../.."),
        }),
      ]);
      expect(readFileSync(sourceConfig, "utf8")).toContain('"name": "cassie-runtime"');
    } finally {
      materialized.dispose();
    }
    expect(existsSync(temporaryConfig)).toBe(false);
    expect(existsSync(dirname(temporaryConfig))).toBe(false);
    materialized.dispose();
  });

  it("anchors the default image build context to the source config directory", () => {
    const root = tempRoot();
    const sourceConfig = join(root, "wrangler.jsonc");
    writeFileSync(
      sourceConfig,
      JSON.stringify({
        name: "placeholder",
        main: "src/index.ts",
        containers: [{ class_name: "BotAgent", image: "Dockerfile" }],
      }),
    );

    const materialized = materializeWorkerWranglerProject({ cwd: root, config: sourceConfig }, "cassie-bot-beta");
    try {
      const config = JSON.parse(readFileSync(materialized.project.config!, "utf8")) as {
        name: string;
        containers: { name: string; image_build_context: string }[];
      };
      expect(config.name).toBe("cassie-bot-beta");
      expect(config.containers[0]?.name).toBe("cassie-bot-beta");
      expect(config.containers[0]?.image_build_context).toBe(root);
    } finally {
      materialized.dispose();
    }
  });

  it("rejects configs that could not map one container app to one Worker", () => {
    const root = tempRoot();
    const sourceConfig = join(root, "wrangler.jsonc");
    writeFileSync(
      sourceConfig,
      JSON.stringify({
        main: "src/index.ts",
        containers: [
          { class_name: "First", image: "Dockerfile.first" },
          { class_name: "Second", image: "Dockerfile.second" },
        ],
      }),
    );

    expect(() =>
      materializeWorkerWranglerProject({ cwd: root, config: sourceConfig }, "cassie-bot-alpha"),
    ).toThrow(/exactly one container/);
  });
});
