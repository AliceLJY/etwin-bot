import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLAUDE_REACTIVE_MAX_TURNS,
  DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS,
  DEFAULT_CODEX_TIMEOUT_MS,
  resolveClaudeMaxTurns,
  resolveCodexTimeoutMs,
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
