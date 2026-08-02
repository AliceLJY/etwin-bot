import { spawn } from "child_process";

export const DEFAULT_AGY_TIMEOUT_MS = 600000;
export const AGY_HARD_TIMEOUT_GRACE_MS = 60000;
export const DEFAULT_AGY_BIN = "/opt/homebrew/bin/agy";

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAgyTimeoutMs(env = process.env) {
  return parsePositiveInteger(
    env.ETWIN_AGY_TIMEOUT_MS || env.LLM_TIMEOUT_MS,
    DEFAULT_AGY_TIMEOUT_MS,
  );
}

export function resolveAgyHardTimeoutMs(printTimeoutMs) {
  return parsePositiveInteger(printTimeoutMs, DEFAULT_AGY_TIMEOUT_MS)
    + AGY_HARD_TIMEOUT_GRACE_MS;
}

export function resolveAgyEffort(model, effort) {
  const allowed = ["low", "medium", "high"];
  const fromModel = allowed.find((candidate) => (
    typeof model === "string" && model.endsWith(`-${candidate}`)
  ));
  if (fromModel) return fromModel;

  const normalized = String(effort || "").toLowerCase();
  return allowed.includes(normalized) ? normalized : null;
}

export function buildAgyArgs(prompt, env = process.env, timeoutMs = resolveAgyTimeoutMs(env)) {
  const args = [
    "-p", String(prompt || ""),
    "--output-format", "json",
    "--print-timeout", `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
  ];
  const model = env.ETWIN_AGY_MODEL || env.AGY_MODEL || "";
  const effort = resolveAgyEffort(model, env.ETWIN_AGY_EFFORT || env.AGY_EFFORT);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

export function normalizeAgyResult(result = {}) {
  const status = String(result.status || "UNKNOWN");
  const response = typeof result.response === "string" ? result.response.trim() : "";
  const detail = typeof result.error === "string" ? result.error.trim() : "";
  const conversationId = result.conversation_id || null;

  if (status === "SUCCESS" && response) {
    return { success: true, text: response, conversationId, partial: false };
  }
  if (response) {
    const warning = detail
      ? `AGY 本轮状态为 ${status}，正文可能不完整：${detail}`
      : `AGY 本轮状态为 ${status}，正文可能不完整。`;
    return {
      success: true,
      text: `${warning}\n\n${response}`,
      conversationId,
      partial: true,
    };
  }

  return {
    success: false,
    text: "",
    conversationId,
    partial: false,
    error: `agy status=${status}${detail ? `: ${detail}` : ""}`,
  };
}

export function parseAgyOutput(stdout = "") {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error("agy returned empty output");

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd < jsonStart) {
      throw new Error("agy returned no JSON result");
    }
    parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
  }

  return normalizeAgyResult(parsed?.event === "result" ? parsed.result : parsed);
}

export function runAgyCli(prompt, options = {}) {
  const env = options.env || process.env;
  const printTimeoutMs = parsePositiveInteger(options.timeoutMs, resolveAgyTimeoutMs(env));
  const hardTimeoutMs = parsePositiveInteger(
    options.hardTimeoutMs,
    resolveAgyHardTimeoutMs(printTimeoutMs),
  );
  const killGraceMs = parsePositiveInteger(options.killGraceMs, 5000);
  const command = env.ETWIN_AGY_BIN || env.AGY_BIN || DEFAULT_AGY_BIN;
  const args = buildAgyArgs(prompt, env, printTimeoutMs);
  const spawnFn = options.spawnFn || spawn;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let stdout = "";
    let stderr = "";
    let killTimer = null;
    let timeout = null;
    let child;

    const finish = (fn, value, { keepKillTimer = false } = {}) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer && !keepKillTimer) clearTimeout(killTimer);
      fn(value);
    };

    try {
      child = spawnFn(command, args, {
        cwd: options.cwd || process.cwd(),
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    timeout = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, killGraceMs);
      killTimer.unref?.();
      finish(
        reject,
        new Error(`agy exceeded hard timeout after ${hardTimeoutMs}ms (elapsed=${Date.now() - startedAt}ms)`),
        { keepKillTimer: true },
      );
    }, hardTimeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      let normalized = null;
      try { normalized = parseAgyOutput(stdout); } catch { /* handled below */ }

      if (normalized?.success) {
        finish(resolve, normalized.text);
        return;
      }

      const elapsed = Date.now() - startedAt;
      const detail = normalized?.error || stderr.slice(-1200) || stdout.slice(-1200) || "(no output)";
      const message = signal
        ? `agy terminated by ${signal} after ${elapsed}ms: ${detail}`
        : `agy exited ${code} after ${elapsed}ms: ${detail}`;
      finish(reject, new Error(message));
    });
  });
}
