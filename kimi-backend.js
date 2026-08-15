import { spawn } from "child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync, lstatSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Kimi Code CLI 后端（`kimi -p` 非交互）。与 agy-backend.js 同构：
// 单次 spawn、stdin=ignore（kimi -p 会等 stdin EOF，见 telegram-ai-bridge/adapters/cli-agent.js）、
// 硬超时后整组 SIGTERM→SIGKILL。
//
// 隔离（2026-08-15 实测）：kimi 默认会把 ~/.kimi-code/AGENTS.md（CC 那套方法论）+ skills + mcp.json
// 全部注入 -p 会话，直接用会让 etwin 串味。所以这里给它一个独立 KIMI_CODE_HOME：
// 只 symlink 凭证与 config.toml（登录态/模型/thinking 跟随用户），skills 空目录、mcp.json 空对象、无 AGENTS.md。

export const DEFAULT_KIMI_TIMEOUT_MS = 600000;
export const KIMI_HARD_TIMEOUT_GRACE_MS = 60000;
export const DEFAULT_KIMI_BIN = join(homedir(), ".kimi-code/bin/kimi");
export const DEFAULT_KIMI_USER_HOME = join(homedir(), ".kimi-code");

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveKimiTimeoutMs(env = process.env) {
  return parsePositiveInteger(
    env.ETWIN_KIMI_TIMEOUT_MS || env.LLM_TIMEOUT_MS,
    DEFAULT_KIMI_TIMEOUT_MS,
  );
}

export function resolveKimiHardTimeoutMs(softTimeoutMs) {
  return parsePositiveInteger(softTimeoutMs, DEFAULT_KIMI_TIMEOUT_MS)
    + KIMI_HARD_TIMEOUT_GRACE_MS;
}

// 独立 home 的位置：默认 <dataDir>/kimi-home（data-*/ 已 gitignore，属运行时数据）
export function resolveKimiHome(env = process.env, dataDir = process.cwd()) {
  return env.ETWIN_KIMI_HOME || join(dataDir, "kimi-home");
}

function ensureLink(target, linkPath) {
  if (existsSync(linkPath) || safeIsSymlink(linkPath)) return;
  if (!existsSync(target)) return; // 用户机上没有的东西不硬造，让 kimi 自己报错
  symlinkSync(target, linkPath);
}

function safeIsSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// 幂等：每次调用前确保隔离 home 就位（新机器 / 换目录后自愈，不给人留文件作业）
export function ensureKimiHome(kimiHome, userHome = DEFAULT_KIMI_USER_HOME) {
  mkdirSync(join(kimiHome, "skills"), { recursive: true });
  ensureLink(join(userHome, "credentials"), join(kimiHome, "credentials"));
  ensureLink(join(userHome, "config.toml"), join(kimiHome, "config.toml"));
  const mcpPath = join(kimiHome, "mcp.json");
  if (!existsSync(mcpPath)) writeFileSync(mcpPath, "{}\n");
  return kimiHome;
}

export function buildKimiArgs(prompt, env = process.env) {
  const args = ["-p", String(prompt || ""), "--output-format", "stream-json"];
  const model = env.ETWIN_KIMI_MODEL || env.KIMI_MODEL || "";
  if (model) args.push("-m", model);
  return args;
}

// stream-json = JSON Lines：assistant(content|tool_calls) / tool / meta。thinking 不进 JSONL，
// 错误 = stderr 明文 + exit≠0，无 error 帧（实测见 telegram-ai-bridge/adapters/kimi.js）。
export function parseKimiOutput(stdout = "") {
  const parts = [];
  let sessionId = null;
  let sawJson = false;
  for (const rawLine of String(stdout || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line[0] !== "{") continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    sawJson = true;
    if (obj.role === "assistant") {
      if (typeof obj.content === "string") parts.push(obj.content);
      else if (Array.isArray(obj.content)) {
        for (const c of obj.content) {
          if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") parts.push(c.text);
          else if (typeof c === "string") parts.push(c);
        }
      }
    } else if (obj.role === "meta" && obj.session_id) {
      sessionId = obj.session_id;
    }
  }
  const text = parts.join("").trim();
  if (text) return { success: true, text, sessionId };
  return {
    success: false,
    text: "",
    sessionId,
    error: sawJson ? "kimi returned no assistant text" : "kimi returned no stream-json",
  };
}

export function runKimiCli(prompt, options = {}) {
  const env = options.env || process.env;
  const softTimeoutMs = parsePositiveInteger(options.timeoutMs, resolveKimiTimeoutMs(env));
  const hardTimeoutMs = parsePositiveInteger(
    options.hardTimeoutMs,
    resolveKimiHardTimeoutMs(softTimeoutMs),
  );
  const killGraceMs = parsePositiveInteger(options.killGraceMs, 5000);
  const command = env.ETWIN_KIMI_BIN || env.KIMI_BIN || DEFAULT_KIMI_BIN;
  const args = buildKimiArgs(prompt, env);
  const spawnFn = options.spawnFn || spawn;
  const kimiHome = options.kimiHome || resolveKimiHome(env, options.dataDir || options.cwd || process.cwd());
  if (!options.skipHomeSetup) ensureKimiHome(kimiHome, options.userHome);
  const childEnv = { ...env, KIMI_CODE_HOME: kimiHome };

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
        env: childEnv,
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
        new Error(`kimi exceeded hard timeout after ${hardTimeoutMs}ms (elapsed=${Date.now() - startedAt}ms)`),
        { keepKillTimer: true },
      );
    }, hardTimeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      const normalized = parseKimiOutput(stdout);
      if (normalized.success && code === 0) {
        finish(resolve, normalized.text);
        return;
      }
      const elapsed = Date.now() - startedAt;
      const detail = stderr.trim().slice(-1200) || normalized.error || stdout.slice(-1200) || "(no output)";
      const message = signal
        ? `kimi terminated by ${signal} after ${elapsed}ms: ${detail}`
        : `kimi exited ${code} after ${elapsed}ms: ${detail}`;
      finish(reject, new Error(message));
    });
  });
}
