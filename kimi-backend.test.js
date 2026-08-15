import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { existsSync, lstatSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_KIMI_TIMEOUT_MS,
  KIMI_HARD_TIMEOUT_GRACE_MS,
  buildKimiArgs,
  ensureKimiHome,
  parseKimiOutput,
  resolveKimiHardTimeoutMs,
  resolveKimiHome,
  resolveKimiTimeoutMs,
  runKimiCli,
} from "./kimi-backend.js";

function fakeSpawn(result = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignals = [];
    child.kill = (signal) => {
      child.killed = true;
      child.killSignals.push(signal);
    };
    calls[calls.length - 1].child = child;
    if (!result.hang) {
      setTimeout(() => {
        if (result.stdout) child.stdout.write(result.stdout);
        if (result.stderr) child.stderr.write(result.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", result.code ?? 0, result.signal ?? null);
      }, 0);
    }
    return child;
  };
  return { calls, spawnFn };
}

const STREAM_OK = [
  JSON.stringify({ role: "assistant", content: "你好，" }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Alice。" }] }),
  JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_abc123" }),
].join("\n");

describe("Kimi runtime config", () => {
  test("uses a ten-minute default and accepts a dedicated timeout", () => {
    expect(resolveKimiTimeoutMs({})).toBe(DEFAULT_KIMI_TIMEOUT_MS);
    expect(resolveKimiTimeoutMs({ LLM_TIMEOUT_MS: "1234" })).toBe(1234);
    expect(resolveKimiTimeoutMs({ LLM_TIMEOUT_MS: "1234", ETWIN_KIMI_TIMEOUT_MS: "99" })).toBe(99);
    expect(resolveKimiHardTimeoutMs(1000)).toBe(1000 + KIMI_HARD_TIMEOUT_GRACE_MS);
  });

  test("keeps the model optional and always asks for stream-json", () => {
    expect(buildKimiArgs("hi", {})).toEqual(["-p", "hi", "--output-format", "stream-json"]);
    expect(buildKimiArgs("hi", { ETWIN_KIMI_MODEL: "kimi-code/k3" })).toEqual([
      "-p", "hi", "--output-format", "stream-json", "-m", "kimi-code/k3",
    ]);
  });

  test("resolves an isolated home under the data dir unless overridden", () => {
    expect(resolveKimiHome({}, "/data/x")).toBe("/data/x/kimi-home");
    expect(resolveKimiHome({ ETWIN_KIMI_HOME: "/elsewhere" }, "/data/x")).toBe("/elsewhere");
  });
});

describe("Kimi isolated home", () => {
  test("links credentials/config only, leaves skills empty, mcp empty, no AGENTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "etwin-kimi-"));
    const userHome = join(root, "user-kimi");
    mkdirSync(join(userHome, "credentials"), { recursive: true });
    writeFileSync(join(userHome, "config.toml"), "default_model = \"x\"\n");
    writeFileSync(join(userHome, "AGENTS.md"), "# rules that must not leak\n");
    writeFileSync(join(userHome, "mcp.json"), JSON.stringify({ mcpServers: { deja: {} } }));

    const home = ensureKimiHome(join(root, "kimi-home"), userHome);
    expect(lstatSync(join(home, "credentials")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "mcp.json"), "utf-8"))).toEqual({});
    expect(existsSync(join(home, "skills"))).toBe(true);
    // 幂等：再跑一次不报错、不改动
    expect(ensureKimiHome(home, userHome)).toBe(home);
  });
});

describe("Kimi stream-json parsing", () => {
  test("concatenates assistant text and captures the session id", () => {
    const parsed = parseKimiOutput(STREAM_OK);
    expect(parsed.success).toBe(true);
    expect(parsed.text).toBe("你好，Alice。");
    expect(parsed.sessionId).toBe("session_abc123");
  });

  test("ignores tool frames and non-JSON noise", () => {
    const out = [
      "some log line",
      JSON.stringify({ role: "tool", content: "ignored" }),
      JSON.stringify({ role: "assistant", tool_calls: [{ id: "x" }] }),
      JSON.stringify({ role: "assistant", content: "done" }),
    ].join("\n");
    expect(parseKimiOutput(out)).toMatchObject({ success: true, text: "done" });
  });

  test("reports missing text distinctly from missing JSON", () => {
    expect(parseKimiOutput("").error).toBe("kimi returned no stream-json");
    expect(parseKimiOutput(JSON.stringify({ role: "meta", session_id: "s" })).error).toBe("kimi returned no assistant text");
  });
});

describe("runKimiCli", () => {
  test("spawns kimi with an isolated KIMI_CODE_HOME and returns the text", async () => {
    const fake = fakeSpawn({ stdout: STREAM_OK });
    const result = await runKimiCli("hello", {
      env: { ETWIN_KIMI_BIN: "/fixture/kimi", HOME: "/fixture/home" },
      cwd: "/fixture/cwd",
      kimiHome: "/fixture/kimi-home",
      skipHomeSetup: true,
      timeoutMs: 1000,
      spawnFn: fake.spawnFn,
    });
    expect(result).toBe("你好，Alice。");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe("/fixture/kimi");
    expect(fake.calls[0].options.cwd).toBe("/fixture/cwd");
    expect(fake.calls[0].options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(fake.calls[0].options.env.KIMI_CODE_HOME).toBe("/fixture/kimi-home");
    expect(fake.calls[0].options.env.HOME).toBe("/fixture/home");
    expect(fake.calls[0].args.slice(0, 2)).toEqual(["-p", "hello"]);
  });

  test("rejects non-zero exits with stderr detail", async () => {
    const fake = fakeSpawn({ stdout: "", stderr: "Authentication required\n", code: 1 });
    await expect(runKimiCli("hello", {
      env: {}, kimiHome: "/fixture/kimi-home", skipHomeSetup: true, timeoutMs: 1000, spawnFn: fake.spawnFn,
    })).rejects.toThrow("kimi exited 1");
    await expect(runKimiCli("hello", {
      env: {}, kimiHome: "/fixture/kimi-home", skipHomeSetup: true, timeoutMs: 1000, spawnFn: fake.spawnFn,
    })).rejects.toThrow("Authentication required");
  });

  test("terminates a hung kimi process at the configured timeout", async () => {
    const fake = fakeSpawn({ hang: true });
    await expect(runKimiCli("hello", {
      env: {}, kimiHome: "/fixture/kimi-home", skipHomeSetup: true,
      timeoutMs: 10, hardTimeoutMs: 20, killGraceMs: 5, spawnFn: fake.spawnFn,
    })).rejects.toThrow("kimi exceeded hard timeout after 20ms");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls[0].options.detached).toBe(true);
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
