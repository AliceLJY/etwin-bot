import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_CLAUDE_REACTIVE_MAX_TURNS,
  DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS,
  DEFAULT_CODEX_CHAT_MAX_ATTEMPTS,
  DEFAULT_CODEX_CHAT_TIMEOUT_MS,
  DEFAULT_CODEX_FULL_TIMEOUT_MS,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SERVICE_TIER,
  DEFAULT_CODEX_TIMEOUT_MS,
  buildSystemPrompt,
  codexPrompt,
  resolveClaudeMaxTurns,
  resolveCodexMaxAttempts,
  resolveCodexReasoningEffort,
  resolveCodexSandbox,
  resolveCodexServiceTier,
  resolveCodexTimeoutMs,
  shouldIgnoreCodexUserConfig,
  shouldUseCodexEphemeral,
} from "./llm.js";

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
});
