import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLAUDE_REACTIVE_MAX_TURNS,
  DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SERVICE_TIER,
  DEFAULT_CODEX_TIMEOUT_MS,
  resolveClaudeMaxTurns,
  resolveCodexReasoningEffort,
  resolveCodexSandbox,
  resolveCodexServiceTier,
  resolveCodexTimeoutMs,
  shouldIgnoreCodexUserConfig,
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

  test("uses the default for invalid values", () => {
    expect(resolveCodexTimeoutMs({ ETWIN_CODEX_TIMEOUT_MS: "nope" })).toBe(DEFAULT_CODEX_TIMEOUT_MS);
    expect(resolveCodexTimeoutMs({ ETWIN_CODEX_TIMEOUT_MS: "0" })).toBe(DEFAULT_CODEX_TIMEOUT_MS);
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
