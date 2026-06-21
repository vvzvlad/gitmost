import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_DRIVER_VALUES,
  DRIVER_OPTIONS,
} from "./ai-agent-role-form";

/**
 * Drift guard: the client's hardcoded driver list must stay in sync with the
 * server `AI_DRIVERS`. Client and server are separate build targets and Vite
 * refuses to import a module from outside the client root, so instead of an
 * `import` we read the server `ai.types.ts` source and parse out the AI_DRIVERS
 * literal. This contract test fails loudly if the two lists ever diverge
 * (order-independent).
 */
function readServerAiDrivers(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/client/src/.../components -> repo apps/server/src/integrations/ai
  const serverTypesPath = path.resolve(
    here,
    "../../../../../../../server/src/integrations/ai/ai.types.ts",
  );
  const source = readFileSync(serverTypesPath, "utf8");
  const match = source.match(/AI_DRIVERS\s*:\s*AiDriver\[\]\s*=\s*\[([^\]]*)\]/);
  if (!match) {
    throw new Error(
      `Could not locate the AI_DRIVERS literal in ${serverTypesPath}`,
    );
  }
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter((s) => s.length > 0);
}

describe("ai-agent-role-form driver drift guard", () => {
  it("mirrors the server AI_DRIVERS list exactly", () => {
    const serverDrivers = readServerAiDrivers();
    expect([...AI_DRIVER_VALUES].sort()).toEqual([...serverDrivers].sort());
  });

  it("exposes one Select option per server driver plus a workspace-default", () => {
    const serverDrivers = readServerAiDrivers();
    const driverOptionValues = DRIVER_OPTIONS.map((o) => o.value).filter(
      (v) => v !== "",
    );
    expect(driverOptionValues.sort()).toEqual([...serverDrivers].sort());
    // Exactly one empty-value option for the "Workspace default" choice.
    expect(DRIVER_OPTIONS.filter((o) => o.value === "")).toHaveLength(1);
  });
});
