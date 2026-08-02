import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  AGY_HARD_TIMEOUT_GRACE_MS,
  DEFAULT_AGY_TIMEOUT_MS,
  buildAgyArgs,
  normalizeAgyResult,
  parseAgyOutput,
  resolveAgyEffort,
  resolveAgyHardTimeoutMs,
  resolveAgyTimeoutMs,
  runAgyCli,
} from "./agy-backend.js";

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

describe("AGY runtime config", () => {
  test("uses a ten-minute default and accepts a dedicated timeout", () => {
    expect(resolveAgyTimeoutMs({})).toBe(DEFAULT_AGY_TIMEOUT_MS);
    expect(resolveAgyTimeoutMs({ ETWIN_AGY_TIMEOUT_MS: "120000" })).toBe(120000);
    expect(resolveAgyTimeoutMs({ ETWIN_AGY_TIMEOUT_MS: "0" })).toBe(DEFAULT_AGY_TIMEOUT_MS);
    expect(resolveAgyHardTimeoutMs(120000)).toBe(120000 + AGY_HARD_TIMEOUT_GRACE_MS);
  });

  test("keeps model and effort optional for the CLI default", () => {
    expect(buildAgyArgs("hello", {}, 120000)).toEqual([
      "-p", "hello",
      "--output-format", "json",
      "--print-timeout", "120s",
    ]);
  });

  test("takes effort from the model suffix to avoid AGY conflicts", () => {
    expect(resolveAgyEffort("gemini-3.1-pro-low", "high")).toBe("low");
    expect(buildAgyArgs("hello", {
      ETWIN_AGY_MODEL: "gemini-3.1-pro-low",
      ETWIN_AGY_EFFORT: "high",
    }, 1000)).toContain("low");
  });
});

describe("AGY result parsing", () => {
  test("returns a successful response", () => {
    expect(normalizeAgyResult({
      status: "SUCCESS",
      response: "hello",
      conversation_id: "conv-1",
    })).toEqual({
      success: true,
      text: "hello",
      conversationId: "conv-1",
      partial: false,
    });
  });

  test("keeps partial text and explains the AGY error", () => {
    const result = normalizeAgyResult({
      status: "ERROR",
      response: "partial answer",
      error: "network issue",
    });
    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.text).toContain("network issue");
    expect(result.text).toContain("partial answer");
  });

  test("reports an error when AGY produced no response", () => {
    expect(normalizeAgyResult({ status: "ERROR", error: "not logged in" })).toEqual({
      success: false,
      text: "",
      conversationId: null,
      partial: false,
      error: "agy status=ERROR: not logged in",
    });
  });

  test("accepts one harmless log line before JSON", () => {
    const result = parseAgyOutput('log line\n{"status":"SUCCESS","response":"pong"}');
    expect(result.text).toBe("pong");
  });

  test("accepts harmless log output before pretty-printed JSON", () => {
    const result = parseAgyOutput('log line\n{\n  "status": "SUCCESS",\n  "response": "pong"\n}');
    expect(result.text).toBe("pong");
  });
});

describe("runAgyCli", () => {
  test("spawns AGY without a shell and returns its JSON response", async () => {
    const fake = fakeSpawn({
      stdout: JSON.stringify({ status: "SUCCESS", response: "AGY says hi" }),
    });
    const result = await runAgyCli("hello", {
      env: { ETWIN_AGY_BIN: "/fixture/agy" },
      cwd: "/fixture/cwd",
      timeoutMs: 1000,
      spawnFn: fake.spawnFn,
    });

    expect(result).toBe("AGY says hi");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe("/fixture/agy");
    expect(fake.calls[0].options.cwd).toBe("/fixture/cwd");
    expect(fake.calls[0].options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(fake.calls[0].args).not.toContain("--conversation");
  });

  test("rejects AGY failures with their original detail", async () => {
    const fake = fakeSpawn({
      stdout: JSON.stringify({ status: "ERROR", response: "", error: "quota unavailable" }),
    });
    await expect(runAgyCli("hello", {
      env: {},
      timeoutMs: 1000,
      spawnFn: fake.spawnFn,
    })).rejects.toThrow("quota unavailable");
  });

  test("terminates a hung AGY process at the configured timeout", async () => {
    const fake = fakeSpawn({ hang: true });
    await expect(runAgyCli("hello", {
      env: {},
      timeoutMs: 10,
      hardTimeoutMs: 20,
      killGraceMs: 5,
      spawnFn: fake.spawnFn,
    })).rejects.toThrow("agy exceeded hard timeout after 20ms");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls[0].options.detached).toBe(true);
    expect(fake.calls[0].child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
