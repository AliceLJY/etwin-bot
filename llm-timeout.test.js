import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_CLAUDE_REACTIVE_MAX_TURNS,
  DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS,
  DEFAULT_CLAUDE_TIMEOUT_MS,
  DEFAULT_CODEX_CHAT_MAX_ATTEMPTS,
  DEFAULT_CODEX_CHAT_TIMEOUT_MS,
  DEFAULT_CODEX_FULL_TIMEOUT_MS,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SERVICE_TIER,
  DEFAULT_CODEX_TIMEOUT_MS,
  buildSystemPrompt,
  callClaudeSDK,
  codexPrompt,
  resolveClaudeMaxTurns,
  resolveClaudeTimeoutMs,
  resolveCodexMaxAttempts,
  resolveCodexReasoningEffort,
  resolveCodexSandbox,
  resolveCodexServiceTier,
  resolveCodexTimeoutMs,
  shouldIgnoreCodexUserConfig,
  shouldUseCodexEphemeral,
} from "./llm.js";

describe("resolveClaudeTimeoutMs", () => {
  test("defaults to ten minutes and accepts the legacy shared timeout", () => {
    expect(resolveClaudeTimeoutMs({})).toBe(DEFAULT_CLAUDE_TIMEOUT_MS);
    expect(resolveClaudeTimeoutMs({ LLM_TIMEOUT_MS: "120000" })).toBe(120000);
  });

  test("prefers the Claude-specific timeout and rejects invalid values", () => {
    expect(resolveClaudeTimeoutMs({
      ETWIN_CLAUDE_TIMEOUT_MS: "240000",
      LLM_TIMEOUT_MS: "120000",
    })).toBe(240000);
    expect(resolveClaudeTimeoutMs({ ETWIN_CLAUDE_TIMEOUT_MS: "0" })).toBe(DEFAULT_CLAUDE_TIMEOUT_MS);
  });

  test("aborts a hanging SDK query when the deadline expires", async () => {
    let observedSignal;
    let closed = false;
    let signalWasAbortedWhenClosed;
    const hangingQuery = ({ options }) => {
      observedSignal = options.abortController.signal;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve, reject) => {
            observedSignal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
          yield { type: "result", result: "unreachable" };
        },
        close() {
          signalWasAbortedWhenClosed = observedSignal.aborted;
          closed = true;
        },
      };
    };

    await expect(callClaudeSDK("timeout test", {
      fresh: true,
      queryFn: hangingQuery,
      timeoutMs: 20,
    })).rejects.toThrow("Claude SDK timed out after 20ms");
    expect(observedSignal.aborted).toBe(true);
    expect(closed).toBe(true);
    expect(signalWasAbortedWhenClosed).toBe(false);
  });

  test("reports timeout when Query.close ends iteration normally", async () => {
    let finishIteration;
    const normallyClosingQuery = () => ({
      [Symbol.asyncIterator]() { return this; },
      next() {
        return new Promise((resolve) => { finishIteration = resolve; });
      },
      close() {
        finishIteration({ done: true, value: undefined });
      },
    });

    await expect(callClaudeSDK("normal close timeout test", {
      fresh: true,
      queryFn: normallyClosingQuery,
      timeoutMs: 20,
    })).rejects.toThrow("Claude SDK timed out after 20ms");
  });

  test("persists a new session after an invalid resume falls back to fresh", async () => {
    let storedSession = "invalid-session";
    const saved = [];
    const sessionStore = {
      load: () => storedSession,
      save: (kind, sessionId) => {
        saved.push([kind, sessionId]);
        storedSession = sessionId;
      },
    };
    const resumeValues = [];
    const recoveringQuery = ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        resumeValues.push(options.resume || null);
        if (options.resume) throw new Error("session not found");
        yield { type: "system", session_id: "recovered-session" };
        yield { type: "result", result: "recovered" };
      },
      close() {},
    });

    const result = await callClaudeSDK("resume test", {
      queryFn: recoveringQuery,
      sessionStore,
      timeoutMs: 1000,
    });

    expect(result).toBe("recovered");
    expect(resumeValues).toEqual(["invalid-session", null]);
    expect(saved).toEqual([["reactive", "recovered-session"]]);
    expect(storedSession).toBe("recovered-session");
  });
});

describe("resolveCodexTimeoutMs", () => {
  test("defaults to 10 minutes for Codex backend", () => {
    expect(resolveCodexTimeoutMs({})).toBe(DEFAULT_CODEX_TIMEOUT_MS);
  });

  test("prefers the Codex-specific timeout", () => {
    expect(resolveCodexTimeoutMs({
      ETWIN_CODEX_TIMEOUT_MS: "600000",
      LLM_TIMEOUT_MS: "240000",
    })).toBe(600000);
  });

  test("falls back to the shared timeout", () => {
    expect(resolveCodexTimeoutMs({ LLM_TIMEOUT_MS: "300000" })).toBe(300000);
  });

  test("uses a shorter chat timeout when tool mode is known", () => {
    expect(resolveCodexTimeoutMs({}, "chat")).toBe(DEFAULT_CODEX_CHAT_TIMEOUT_MS);
    expect(resolveCodexTimeoutMs({}, "full")).toBe(DEFAULT_CODEX_FULL_TIMEOUT_MS);
  });

  test("accepts mode-specific timeout overrides", () => {
    expect(resolveCodexTimeoutMs({ ETWIN_CODEX_CHAT_TIMEOUT_MS: "180000" }, "chat")).toBe(180000);
    expect(resolveCodexTimeoutMs({ ETWIN_CODEX_FULL_TIMEOUT_MS: "900000" }, "full")).toBe(900000);
  });

  test("uses the default for invalid values", () => {
    expect(resolveCodexTimeoutMs({ ETWIN_CODEX_TIMEOUT_MS: "nope" })).toBe(DEFAULT_CODEX_TIMEOUT_MS);
    expect(resolveCodexTimeoutMs({ ETWIN_CODEX_TIMEOUT_MS: "0" })).toBe(DEFAULT_CODEX_TIMEOUT_MS);
  });
});

describe("resolveCodexMaxAttempts", () => {
  test("retries Codex reactive chat once by default", () => {
    expect(resolveCodexMaxAttempts("reactive", "chat", {})).toBe(DEFAULT_CODEX_CHAT_MAX_ATTEMPTS);
  });

  test("does not retry full mode or self-loop by default", () => {
    expect(resolveCodexMaxAttempts("reactive", "full", {})).toBe(1);
    expect(resolveCodexMaxAttempts("self-loop", "chat", {})).toBe(1);
  });

  test("accepts a bounded chat retry override", () => {
    expect(resolveCodexMaxAttempts("reactive", "chat", { ETWIN_CODEX_CHAT_MAX_ATTEMPTS: "1" })).toBe(1);
    expect(resolveCodexMaxAttempts("reactive", "chat", { ETWIN_CODEX_CHAT_MAX_ATTEMPTS: "9" })).toBe(3);
  });
});

describe("resolveCodexReasoningEffort", () => {
  test("defaults Codex chat to top effort", () => {
    expect(resolveCodexReasoningEffort({})).toBe(DEFAULT_CODEX_REASONING_EFFORT);
  });

  test("accepts supported effort overrides", () => {
    expect(resolveCodexReasoningEffort({ ETWIN_CODEX_REASONING_EFFORT: "medium" })).toBe("medium");
    expect(resolveCodexReasoningEffort({ ETWIN_CODEX_REASONING_EFFORT: "XHIGH" })).toBe("xhigh");
  });

  test("uses the default for invalid effort overrides", () => {
    expect(resolveCodexReasoningEffort({ ETWIN_CODEX_REASONING_EFFORT: "maximum" })).toBe(DEFAULT_CODEX_REASONING_EFFORT);
  });
});

describe("resolveCodexServiceTier", () => {
  test("defaults Codex chat to fast tier", () => {
    expect(resolveCodexServiceTier({})).toBe(DEFAULT_CODEX_SERVICE_TIER);
  });

  test("accepts supported service tier overrides", () => {
    expect(resolveCodexServiceTier({ ETWIN_CODEX_SERVICE_TIER: "flex" })).toBe("flex");
    expect(resolveCodexServiceTier({ CODEX_SERVICE_TIER: "FAST" })).toBe("fast");
  });

  test("disables service tier override for invalid values", () => {
    expect(resolveCodexServiceTier({ ETWIN_CODEX_SERVICE_TIER: "premium" })).toBe("");
  });
});

describe("shouldIgnoreCodexUserConfig", () => {
  test("isolates Codex Twin chat mode from user config by default", () => {
    expect(shouldIgnoreCodexUserConfig("chat", {})).toBe(true);
  });

  test("lets Codex Twin full mode inherit user config by default", () => {
    expect(shouldIgnoreCodexUserConfig("full", {})).toBe(false);
  });

  test("allows explicit chat and full overrides", () => {
    expect(shouldIgnoreCodexUserConfig("chat", { ETWIN_CODEX_CHAT_IGNORE_USER_CONFIG: "false" })).toBe(false);
    expect(shouldIgnoreCodexUserConfig("full", { ETWIN_CODEX_FULL_IGNORE_USER_CONFIG: "true" })).toBe(true);
  });
});

describe("shouldUseCodexEphemeral", () => {
  test("uses ephemeral sessions for chat mode by default", () => {
    expect(shouldUseCodexEphemeral("chat", {})).toBe(true);
  });

  test("keeps full mode persistent unless explicitly enabled", () => {
    expect(shouldUseCodexEphemeral("full", {})).toBe(false);
    expect(shouldUseCodexEphemeral("full", { ETWIN_CODEX_FULL_EPHEMERAL: "true" })).toBe(true);
  });

  test("allows chat mode to opt out", () => {
    expect(shouldUseCodexEphemeral("chat", { ETWIN_CODEX_CHAT_EPHEMERAL: "false" })).toBe(false);
  });
});

describe("resolveCodexSandbox", () => {
  test("keeps chat mode read-only by default", () => {
    expect(resolveCodexSandbox("chat", {})).toBe("read-only");
  });

  test("uses workspace-write for full mode by default", () => {
    expect(resolveCodexSandbox("full", {})).toBe("workspace-write");
  });

  test("accepts explicit sandbox overrides", () => {
    expect(resolveCodexSandbox("chat", { ETWIN_CODEX_CHAT_SANDBOX: "workspace-write" })).toBe("workspace-write");
    expect(resolveCodexSandbox("full", { ETWIN_CODEX_FULL_SANDBOX: "danger-full-access" })).toBe("danger-full-access");
  });
});

describe("resolveClaudeMaxTurns", () => {
  test("keeps self-loop conservative", () => {
    expect(resolveClaudeMaxTurns("self-loop", {})).toBe(DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS);
  });

  test("defaults reactive turns to a larger tool budget", () => {
    expect(resolveClaudeMaxTurns("reactive", {})).toBe(DEFAULT_CLAUDE_REACTIVE_MAX_TURNS);
  });

  test("accepts explicit runtime overrides", () => {
    expect(resolveClaudeMaxTurns("self-loop", { ETWIN_CLAUDE_SELF_LOOP_MAX_TURNS: "2" })).toBe(2);
    expect(resolveClaudeMaxTurns("reactive", { ETWIN_CLAUDE_REACTIVE_MAX_TURNS: "40" })).toBe(40);
  });

  test("uses defaults for invalid turn overrides", () => {
    expect(resolveClaudeMaxTurns("self-loop", { ETWIN_CLAUDE_SELF_LOOP_MAX_TURNS: "nope" })).toBe(DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS);
    expect(resolveClaudeMaxTurns("reactive", { ETWIN_CLAUDE_REACTIVE_MAX_TURNS: "0" })).toBe(DEFAULT_CLAUDE_REACTIVE_MAX_TURNS);
  });
});

describe("DEFAULT_CLAUDE_MODEL", () => {
  test("uses the Opus alias instead of pinning an old point release", async () => {
    const mod = await import("./llm.js");

    expect(mod.DEFAULT_CLAUDE_MODEL).toBe("opus");
  });
});

describe("shouldUseClaudeFreshSession", () => {
  test("uses fresh Claude sessions for self-loop while keeping reactive resumable", async () => {
    const mod = await import("./llm.js");

    expect(mod.shouldUseClaudeFreshSession("self-loop", {})).toBe(true);
    expect(mod.shouldUseClaudeFreshSession("reactive", {})).toBe(false);
  });
});

describe("buildSystemPrompt", () => {
  test("keeps chat prompt lighter than full work prompt", () => {
    const chatPrompt = buildSystemPrompt("chat");
    const fullPrompt = buildSystemPrompt("full");

    expect(chatPrompt).toContain("普通 Telegram 对话");
    expect(chatPrompt).not.toContain("Self-Healing");
    expect(fullPrompt).toContain("操作纪律");
    expect(fullPrompt).toContain("Self-Healing");
    expect(chatPrompt.length).toBeLessThan(fullPrompt.length);
  });

  test("tells full Codex work mode to fall back from web search to local GitHub checks", () => {
    const fullPrompt = buildSystemPrompt("full");

    expect(fullPrompt).toContain("GitHub 链接");
    expect(fullPrompt).toContain("gh repo view");
    expect(fullPrompt).toContain("api.github.com/repos");
    expect(fullPrompt).toContain("git ls-remote");
    expect(fullPrompt).toContain("不要只靠搜索引擎");
  });
});

describe("codexPrompt", () => {
  test("keeps self-loop JSON output constraints instead of Telegram text constraints", () => {
    const prompt = codexPrompt('{"action":"ping"}', "self-loop", "chat");

    expect(prompt).toContain("严格 JSON");
    expect(prompt).not.toContain("不要包 JSON");
  });
});

describe("Codex self-loop prompt", () => {
  test("allows light proactive pings instead of defaulting to silent", () => {
    const prompt = readFileSync(join(import.meta.dir, "prompts/self-decision-codex.md"), "utf-8");

    expect(prompt).toContain("默认可以 ping");
    expect(prompt).not.toContain("默认 silent");
    expect(prompt).not.toContain("24 小时内已经 ping 过");
  });

  test("does not hard-silence the 7am morning window", () => {
    const prompt = readFileSync(join(import.meta.dir, "prompts/self-decision-codex.md"), "utf-8");

    expect(prompt).toContain("`hour_of_day` 在 2-6 → silent");
    expect(prompt).not.toContain("`hour_of_day` 在 2-7 → silent");
  });
});
