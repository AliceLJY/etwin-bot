import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = import.meta.dir;
const llmModulePath = join(root, "llm.js");

function childEnv(fakeHome) {
  return {
    ...process.env,
    HOME: fakeHome,
    ETWIN_DATA_DIR: join(fakeHome, "runtime-data"),
    ETWIN_FILE_DIR: join(fakeHome, "runtime-files"),
    ETWIN_LLM_BACKEND: "claude",
  };
}

describe("Claude MCP configuration loading", () => {
  test("does not read user-scope MCP configuration during module import", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "etwin-llm-import-"));
    const fakeHome = join(temporaryRoot, "home");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, ".claude.json"), "{ deliberately invalid JSON", { mode: 0o600 });

    try {
      const result = spawnSync(process.execPath, [
        "-e",
        `await import(${JSON.stringify(llmModulePath)}); console.log("IMPORT_OK");`,
      ], {
        cwd: root,
        env: childEnv(fakeHome),
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("IMPORT_OK");
      expect(result.stderr).not.toContain("mcpServers");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("loads user-scope MCP configuration for a full-tool query", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "etwin-llm-full-query-"));
    const fakeHome = join(temporaryRoot, "home");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({
      mcpServers: {
        recallnest: {
          command: "fake-mcp-command",
          args: ["--fixture-only"],
        },
      },
    }), { mode: 0o600 });

    const childScript = `
      const { callClaudeSDK } = await import(${JSON.stringify(llmModulePath)});
      const queryFn = ({ options }) => ({
        async *[Symbol.asyncIterator]() {
          const configured = options.mcpServers?.recallnest;
          if (configured?.command !== "fake-mcp-command") {
            throw new Error("full-tool query did not load the fake MCP fixture");
          }
          yield { type: "result", result: "FULL_QUERY_CONFIG_OK" };
        },
        close() {},
      });
      const result = await callClaudeSDK("fixture query", {
        fresh: true,
        toolMode: "full",
        queryFn,
        timeoutMs: 1000,
        sessionStore: { load: () => null, save: () => {} },
      });
      if (result !== "FULL_QUERY_CONFIG_OK") throw new Error("unexpected query result");
      console.log(result);
    `;

    try {
      const result = spawnSync(process.execPath, ["-e", childScript], {
        cwd: root,
        env: childEnv(fakeHome),
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("FULL_QUERY_CONFIG_OK");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
