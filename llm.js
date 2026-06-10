// llm.js — Claude Agent SDK 调用 + session resume 让 cache 复用
// 取代旧版的 spawn `claude -p` 子进程模式

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { DATA_DIR, PROJECT_DIR, dataPath, ensureRuntimeDirs, readPromptFile } from "./paths.js";
import { TOOL_MODE_CHAT, TOOL_MODE_FULL, normalizeToolMode } from "./tool-mode.js";

ensureRuntimeDirs();

const SESSION_STORE = dataPath("session-ids.json");
export const DEFAULT_CODEX_TIMEOUT_MS = 600000;
export const DEFAULT_CODEX_CHAT_TIMEOUT_MS = 300000;
export const DEFAULT_CODEX_FULL_TIMEOUT_MS = 600000;
export const DEFAULT_CODEX_CHAT_MAX_ATTEMPTS = 2;
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";
export const DEFAULT_CODEX_CHAT_REASONING_EFFORT = "medium";
export const DEFAULT_CODEX_FULL_REASONING_EFFORT = "high";
export const DEFAULT_CODEX_SERVICE_TIER = "fast";
export const DEFAULT_CLAUDE_MODEL = "opus";
export const DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS = 1;
export const DEFAULT_CLAUDE_REACTIVE_MAX_TURNS = 30;

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCodexTimeoutMs(env = process.env, toolMode = null) {
  if (toolMode) {
    const mode = normalizeToolMode(toolMode);
    if (mode === TOOL_MODE_CHAT) {
      const raw = env.ETWIN_CODEX_CHAT_TIMEOUT_MS || env.ETWIN_CODEX_TIMEOUT_MS || env.LLM_TIMEOUT_MS || String(DEFAULT_CODEX_CHAT_TIMEOUT_MS);
      return parsePositiveInteger(raw, DEFAULT_CODEX_CHAT_TIMEOUT_MS);
    }
    if (mode === TOOL_MODE_FULL) {
      const raw = env.ETWIN_CODEX_FULL_TIMEOUT_MS || env.ETWIN_CODEX_TIMEOUT_MS || env.LLM_TIMEOUT_MS || String(DEFAULT_CODEX_FULL_TIMEOUT_MS);
      return parsePositiveInteger(raw, DEFAULT_CODEX_FULL_TIMEOUT_MS);
    }
  }
  const raw = env.ETWIN_CODEX_TIMEOUT_MS || env.LLM_TIMEOUT_MS || String(DEFAULT_CODEX_TIMEOUT_MS);
  return parsePositiveInteger(raw, DEFAULT_CODEX_TIMEOUT_MS);
}

export function resolveCodexMaxAttempts(kind = "reactive", toolMode = TOOL_MODE_CHAT, env = process.env) {
  if (kind !== "reactive" || normalizeToolMode(toolMode) !== TOOL_MODE_CHAT) return 1;
  return Math.min(parsePositiveInteger(env.ETWIN_CODEX_CHAT_MAX_ATTEMPTS, DEFAULT_CODEX_CHAT_MAX_ATTEMPTS), 3);
}

export function shouldUseCodexEphemeral(toolMode = TOOL_MODE_CHAT, env = process.env) {
  const mode = normalizeToolMode(toolMode);
  if (mode === TOOL_MODE_FULL) return env.ETWIN_CODEX_FULL_EPHEMERAL === "true";
  return env.ETWIN_CODEX_CHAT_EPHEMERAL !== "false";
}

export function resolveCodexReasoningEffort(env = process.env, toolMode = null) {
  const allowed = ["low", "medium", "high", "xhigh"];
  const pick = (raw, fallback) => {
    const value = String(raw || fallback).toLowerCase();
    return allowed.includes(value) ? value : fallback;
  };
  if (toolMode) {
    const mode = normalizeToolMode(toolMode);
    if (mode === TOOL_MODE_CHAT) {
      return pick(env.ETWIN_CODEX_CHAT_REASONING_EFFORT || env.ETWIN_CODEX_REASONING_EFFORT, DEFAULT_CODEX_CHAT_REASONING_EFFORT);
    }
    if (mode === TOOL_MODE_FULL) {
      return pick(env.ETWIN_CODEX_FULL_REASONING_EFFORT || env.ETWIN_CODEX_REASONING_EFFORT, DEFAULT_CODEX_FULL_REASONING_EFFORT);
    }
  }
  return pick(env.ETWIN_CODEX_REASONING_EFFORT, DEFAULT_CODEX_REASONING_EFFORT);
}

export function shouldIgnoreCodexUserConfig(toolMode = TOOL_MODE_CHAT, env = process.env) {
  const mode = normalizeToolMode(toolMode);
  if (mode === TOOL_MODE_FULL) {
    return env.ETWIN_CODEX_FULL_IGNORE_USER_CONFIG === "true";
  }
  return env.ETWIN_CODEX_CHAT_IGNORE_USER_CONFIG !== "false" && env.ETWIN_CODEX_IGNORE_USER_CONFIG !== "false";
}

export function resolveCodexServiceTier(env = process.env) {
  const value = (env.ETWIN_CODEX_SERVICE_TIER || env.CODEX_SERVICE_TIER || DEFAULT_CODEX_SERVICE_TIER).toLowerCase();
  return ["fast", "flex"].includes(value) ? value : "";
}

export function resolveCodexSandbox(toolMode = TOOL_MODE_CHAT, env = process.env) {
  const mode = normalizeToolMode(toolMode);
  const value = mode === TOOL_MODE_FULL
    ? env.ETWIN_CODEX_FULL_SANDBOX || "workspace-write"
    : env.ETWIN_CODEX_CHAT_SANDBOX || env.ETWIN_CODEX_SANDBOX || "read-only";
  return ["read-only", "workspace-write", "danger-full-access"].includes(value) ? value : "read-only";
}

export function resolveClaudeMaxTurns(kind = "reactive", env = process.env) {
  if (kind === "self-loop") {
    return parsePositiveInteger(env.ETWIN_CLAUDE_SELF_LOOP_MAX_TURNS, DEFAULT_CLAUDE_SELF_LOOP_MAX_TURNS);
  }
  return parsePositiveInteger(env.ETWIN_CLAUDE_REACTIVE_MAX_TURNS, DEFAULT_CLAUDE_REACTIVE_MAX_TURNS);
}

export function shouldUseClaudeFreshSession(kind = "reactive", opts = {}) {
  return opts.fresh === true || kind === "self-loop";
}

// SDK 0.2.117+ 砍掉了内置 cli.js，必须显式传 claude CLI 路径
const CLAUDE_CLI_PATH =
  process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");

const LLM_MODEL = process.env.ETWIN_LLM_MODEL || DEFAULT_CLAUDE_MODEL;
const LLM_EFFORT = process.env.ETWIN_LLM_EFFORT || null; // 不指定走默认
const LLM_BACKEND = process.env.ETWIN_LLM_BACKEND || process.env.ETWIN_LLM_MODE || "claude";
const ENABLE_CODEX_MCP = process.env.ETWIN_ENABLE_CODEX_MCP === "true";

// 让 etwin-bot 产生的 session 也能出现在终端 /resume 列表
// 详见 telegram-ai-bridge/adapters/claude.js 同款 hack
if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
}

// === MCP 注入 + 工具白名单 ===
// 背景：sdkOptions.settingSources=[] 屏蔽 Alice CLAUDE.md 工程规则避免人格污染，
// 副作用是 user-scope MCP servers 也跟着没了——E-Twin 只剩 SDK 内置工具，
// WebFetch 撞 SPA（如 claude.ai/share）就拿空壳。这里把"该有的工具"补回来。

// 从 user-scope ~/.claude.json 抽指定的 MCP server 配置
// 保 secret 在原文件，未来 JINA_API_KEY / ssh mini 路径变了自动同步
function loadUserScopeMcpServers(names) {
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (!existsSync(claudeJsonPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    const all = parsed.mcpServers || {};
    return Object.fromEntries(names.filter(n => all[n]).map(n => [n, all[n]]));
  } catch (e) {
    console.error(`[etwin] 读 ~/.claude.json mcpServers 失败: ${e.message}`);
    return {};
  }
}

// E-Twin 全能版工具池：
// - playwright: 抓 SPA / 动态渲染页面（claude.ai/share、小红书等）
// - context7: 查 SDK / 库文档（写代码时随时可用）
// - recallnest: recall + write Alice 记忆（write 时 scope 强制 etwin，不污染 Alice）
// - gemini-web-image: 免费链路画图
// Codex MCP 默认不接入，避免 CC -> Codex MCP -> Codex MCP 的套娃卡死。
// 明确需要跨代理时仍可让 CC 通过 Bash 调 `codex exec`。
// plugin-based 的（playwright/context7）hardcode npx 命令；user-scope 的从 ~/.claude.json 抽
const ETWIN_MCP_SERVERS = {
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest"],
  },
  context7: {
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
  },
  // recallnest / gemini-web-image 在 user-scope（含 JINA_API_KEY / OAuth / ssh 路径）
  ...loadUserScopeMcpServers(ENABLE_CODEX_MCP
    ? ["recallnest", "codex", "gemini-web-image"]
    : ["recallnest", "gemini-web-image"]),
};

// 白名单：让 E-Twin 像 CC 一样能干活——写代码 / 跑命令 / 抓信息 / 查记忆 / 画图 / 调 codex
// 不放：Task（防 spawn subagent 套娃）、NotebookEdit（很少用）
// MCP 工具用 prefix 通配，每个 server 全工具开放
// 危险动作（rm -rf / sudo / git push main）靠 systemPrompt 的「操作纪律」段管，不靠工具黑名单
const ETWIN_ALLOWED_TOOLS = [
  // SDK 内置
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  // MCP 通配
  "mcp__playwright__*",
  "mcp__context7__*",
  "mcp__recallnest__*",
  "mcp__gemini-web-image__*",
  ...(ENABLE_CODEX_MCP ? ["mcp__codex__*"] : []),
];

// 操作纪律：附加到 systemPrompt 末尾。约束行动而不影响 voice persona
const ETWIN_OPS_DISCIPLINE = `

---

# 操作纪律（你干活时遵守的底线，不改你的说话风格）

你说话用当前 persona 文件定义的 voice。但当 Alice 让你查信息 / 写代码 / 改文件 / 跑命令时，遵守这些工程纪律——这是 Alice 的工作流底线，不是你的闲聊人格：

- 删文件用 \`mv\` 到 \`~/.Trash/\`，不用 \`rm\`。除非 Alice 明确要求并理解后果。
- \`git push\` 前先 \`git remote -v\` 确认 remote 和 branch；推 main/master 前再问 Alice 一次。
- 修代码前先 \`Read\` 现状，不靠回忆推断 API。改 API/加参数时 grep 所有 caller 确认。
- Alice 发 GitHub 链接、网页链接，或说"直接看/打开/读"时，必须先用真实工具确认内容再评价。内置网页打开或 WebSearch 没拿到内容时，不要只靠搜索引擎，也不要凭链接标题/预览/仓库名猜。GitHub 链接优先退回本地命令：\`gh repo view owner/repo --json nameWithOwner,description,isPrivate,visibility,url,updatedAt\`、\`curl -L https://api.github.com/repos/owner/repo\`、\`git ls-remote https://github.com/owner/repo.git\`；如果是 AliceLJY 的本机仓库，再查 \`~/Projects/<repo>\`。普通网页用 \`curl -L\`，SPA/登录态页面再用 Playwright。
- 跑长命令（预估 > 5 分钟）传 \`run_in_background: true\`，不要长期阻塞。
- 写 RecallNest 时 scope 强制传 \`"etwin:default"\` 或 \`"project:etwin-bot"\`——不要写到 Alice 自己的 RN scope 里污染她的记忆。
- 图片生成请求由外层 \`bot.js -> image-generation.js\` 统一处理；你在工具链里只负责解释/排查图片管线，不要再调用 Codex MCP 或 \`codex exec\` 去生成图片。
- 不确定就说"不确定 / 待确认"，不编造 file path 或 API 行为，不假装跑过命令。
- 别用工程师速记词（落盘 / 齐活 / 搞定 / 一把梭 / 跑通 / 干到头）——这违背 persona voice，宁可多说几个字。
- 你跑在 mini 上（不在 MacBook）。要操作 MacBook 上的文件用 \`ssh mac …\`；要操作 mini 本地直接跑。

## Self-Healing（自己查自己修——Alice 明确意图，别再让她转述）

你出问题时，自己排自己修，不要让 Alice 当转述员去叫 CC。流程：

1. **诊断**：看自己日志 \`tail -100 ~/Projects/etwin-bot/etwin-bot.log\`、ps 自己进程、ls 自己代码、grep 错误关键词
2. **修改**：改自己 \`~/Projects/etwin-bot/\` 下的代码。**改前先 \`cp llm.js llm.js.bak\` 备份**（self-rollback 的安全网）
3. **校验**：syntax check \`bun -e "import('./llm.js').then(()=>console.log('ok')).catch(e=>{console.error(e);process.exit(1)})"\`
4. **提交**：\`git add . && git commit -m "fix: ..."\`（etwin-bot 没 remote，不需要 push）
5. **重启自己**：\`launchctl kickstart -k gui/\$(id -u)/com.etwin-bot\`。KeepAlive=true 自动起新进程加载新代码。
6. **rollback 兜底**：若新进程启动失败/反复 crash，\`mv llm.js.bak llm.js && launchctl kickstart -k ...\` 回退到上一版。

修自己（\`~/Projects/etwin-bot/\` 范围、自己的 \`com.etwin-bot\` launchd 服务）**不需要问 Alice**——这是设计意图。

但**操作别人的东西要先问 Alice**：
- 别人的 launchd 服务（telegram-ai-bridge / hermes-aws / 其他 bot）
- Alice 自己的项目代码（~/Projects/{telegram-ai-bridge, recallnest, content-publisher, ...} 等）
- 危险操作（\`git push --force\` / drop database / \`sudo rm\` 任何 / 改两机基础设施配置 / 关 Tailscale / 改 ~/.claude.json）
- 任何会影响 Alice 主力工作流的事

简言之：自己的家自己收拾；别人的地盘进去先敲门。`;

const ETWIN_CHAT_DISCIPLINE = `

---

# 普通 Telegram 对话

这一轮只是自然聊天。不要主动查文件、跑命令、解释工具链路或进入排障流程；先按当前 persona 回应 Alice 话里的情绪、欲望和关系感。

如果 Alice 明确要求你查信息、看文件、改代码、重启服务或生成图片，外层路由会把你切到工作链路；在普通对话里别自己加戏。

回复保持中文、短自然段、双换行分隔。`;

// 读 persona 三件套 + 追加 long-term-memory 拼成 system prompt append
export function buildSystemPrompt(toolMode = TOOL_MODE_FULL) {
  const personaMode = process.env.ETWIN_PERSONA || (LLM_BACKEND === "codex" ? "codex" : "etwin");
  let personaPrompt;
  if (personaMode === "codex") {
    personaPrompt = readPromptFile(join(PROJECT_DIR, "persona/codex-tuning.md"));
  } else if (personaMode === "cc") {
    personaPrompt = readPromptFile(join(PROJECT_DIR, "persona/cc-tuning.md"));
  } else {
    const base = readPromptFile(join(PROJECT_DIR, "persona/digital-clone-base.md"));
    const profile = readPromptFile(join(PROJECT_DIR, "persona/digital-clone-profile.md"));
    const tuning = readPromptFile(join(PROJECT_DIR, "persona/e-tuning.md"));
    personaPrompt = `${base}\n\n---\n\n${profile}\n\n---\n\n${tuning}`;
  }

  // long-term memory 注入（每次 distill 后自动累积）
  let memorySection = "";
  const memPath = dataPath("long-term-memory.json");
  if (existsSync(memPath)) {
    try {
      const memory = JSON.parse(readFileSync(memPath, "utf-8"));
      if (Array.isArray(memory) && memory.length > 0) {
        // 按 importance 倒序，重要的先看
        const sorted = [...memory].sort((a, b) => (b.importance || 0) - (a.importance || 0));
        const lines = sorted.map((m) => {
          const cat = m.category || "fact";
          const imp = typeof m.importance === "number" ? m.importance.toFixed(2) : "?";
          const period = m.period ? ` [${m.period}]` : "";
          return `- [${cat} · imp=${imp}]${period} ${m.fact}`;
        });
        memorySection = `\n\n---\n\n# Long-term Memory（你和 Alice 关系中累积的关键 facts，distill 自动生成）\n\n${lines.join("\n")}\n\n这些是你"长大"过程里沉淀的记忆。每次 distill 时会自动累积。你说话时不需要刻意引用，但内心保有这些知道。`;
      }
    } catch (_) {}
  }

  const mode = normalizeToolMode(toolMode);
  const discipline = mode === TOOL_MODE_FULL ? ETWIN_OPS_DISCIPLINE : ETWIN_CHAT_DISCIPLINE;
  return `${personaPrompt}${memorySection}${discipline}`;
}

export function codexPrompt(userPrompt, kind, toolMode) {
  const mode = normalizeToolMode(toolMode);
  const outputConstraints = kind === "self-loop"
    ? `只输出 self-decision prompt 要求的严格 JSON 对象。不要 markdown，不要解释，不要把消息正文单独抽出来。`
    : `只输出要发给 Alice 的内容。不要解释你用了什么工具，不要写 markdown 标题，不要包 JSON。
如果这是 reactive 聊天，用双换行分成 1-5 条自然 Telegram 消息。`;

  return `${buildSystemPrompt(toolMode)}

---

# 当前 Telegram 回合

- backend: codex
- kind: ${kind}
- task_intent: ${mode === TOOL_MODE_FULL ? "work-with-tools-if-needed" : "conversation"}

${userPrompt}

---

# 输出约束

${outputConstraints}`;
}

function spawnCodex(args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const child = spawn("codex", args, {
      cwd: PROJECT_DIR,
      env: process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (err) => finish(reject, err);
    const succeed = (value) => finish(resolve, value);

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (_) {
        child.kill("SIGTERM");
      }
      fail(new Error(`codex exec timed out after ${timeoutMs}ms (elapsed=${Date.now() - startedAt}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      const elapsed = Date.now() - startedAt;
      if (code === 0) succeed({ stdout, stderr });
      else if (signal) fail(new Error(`codex exec terminated by ${signal} after ${elapsed}ms: ${stderr.slice(-1200) || stdout.slice(-1200)}`));
      else fail(new Error(`codex exec exited ${code} after ${elapsed}ms: ${stderr.slice(-1200) || stdout.slice(-1200)}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function isRetryableCodexError(err) {
  const message = err?.message || "";
  return message.includes("returned empty output") || message.includes("exited null");
}

async function callCodexExec(userPrompt, opts = {}) {
  const dryRun = opts.dryRun || process.env.ETWIN_DRY_RUN === "true";
  const kind = opts.kind || "reactive";
  const toolMode = normalizeToolMode(opts.toolMode || TOOL_MODE_CHAT);

  if (dryRun) {
    console.log(`[codex dry-run kind=${kind} toolMode=${toolMode}] prompt 长度:`, userPrompt.length);
    return kind === "self-loop"
      ? JSON.stringify({ action: "silent", message: "", reasoning: "[dry-run mock] codex backend", next_check_hint: "4_hours" })
      : "[dry-run] 当前是 Codex dry-run 模式，未真调 LLM。";
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const outputPath = dataPath(`codex-last-${kind}.txt`);
  const model = process.env.ETWIN_CODEX_MODEL || process.env.CODEX_MODEL || null;
  const sandbox = resolveCodexSandbox(toolMode);
  const timeoutMs = resolveCodexTimeoutMs(process.env, toolMode);
  const maxAttempts = resolveCodexMaxAttempts(kind, toolMode);
  const reasoningEffort = resolveCodexReasoningEffort(process.env, toolMode);
  const serviceTier = resolveCodexServiceTier();
  const images = (opts.images || []).filter((imagePath) => imagePath && existsSync(imagePath));

  const args = [
    "exec",
  ];
  if (shouldIgnoreCodexUserConfig(toolMode)) {
    args.push("--ignore-user-config");
  }
  args.push(
    "--cd", PROJECT_DIR,
    "--sandbox", sandbox,
    "--ignore-rules",
    "-c", `model_reasoning_effort="${reasoningEffort}"`,
    "-o", outputPath,
  );
  if (shouldUseCodexEphemeral(toolMode)) {
    args.push("--ephemeral");
  }
  if (serviceTier) {
    args.push("-c", `service_tier="${serviceTier}"`);
  }
  if (model) args.push("--model", model);
  for (const imagePath of images) {
    args.push("--image", imagePath);
  }
  args.push("-");

  const prompt = codexPrompt(userPrompt, kind, toolMode);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      writeFileSync(outputPath, "");
      console.log(`[codex] exec kind=${kind} toolMode=${toolMode} attempt=${attempt}/${maxAttempts} model=${model || "(default)"} effort=${reasoningEffort} tier=${serviceTier || "(default)"} sandbox=${sandbox} ignore_user_config=${shouldIgnoreCodexUserConfig(toolMode)} ephemeral=${shouldUseCodexEphemeral(toolMode)} timeout=${timeoutMs}`);
      const { stdout } = await spawnCodex(args, prompt, timeoutMs);

      const fileOutput = existsSync(outputPath) ? readFileSync(outputPath, "utf-8").trim() : "";
      const output = fileOutput || stdout.trim();
      if (output) return output;

      throw new Error("codex exec returned empty output");
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isRetryableCodexError(err)) {
        console.warn(`[codex] retrying after transient empty/exit failure: ${err.message.slice(0, 200)}`);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("codex exec failed without error detail");
}

// 持久化 session id：让 self-loop / reactive 各自维护一个 session 用于 resume
// kind: "self-loop" | "reactive"
function loadSessionId(kind) {
  if (!existsSync(SESSION_STORE)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_STORE, "utf-8"));
    return data[kind] || null;
  } catch (_e) {
    return null;
  }
}

function saveSessionId(kind, sessionId) {
  let data = {};
  if (existsSync(SESSION_STORE)) {
    try { data = JSON.parse(readFileSync(SESSION_STORE, "utf-8")); } catch (_) {}
  }
  data[kind] = sessionId;
  data[`${kind}_updated`] = new Date().toISOString();
  writeFileSync(SESSION_STORE, JSON.stringify(data, null, 2));
}

// 核心调用：走 SDK，session resume + cache hit
// opts.kind: "self-loop" | "reactive" — 不同 kind 各自维护 session
// opts.dryRun: 干跑不真调
// opts.fresh: 不 resume，强制新 session
// 返回 string（assistant 输出的文本）
export async function callClaudeSDK(userPrompt, opts = {}) {
  if (LLM_BACKEND === "codex") {
    return await callCodexExec(userPrompt, opts);
  }

  const dryRun = opts.dryRun || process.env.ETWIN_DRY_RUN === "true";
  const kind = opts.kind || "reactive";
  const toolMode = normalizeToolMode(opts.toolMode || TOOL_MODE_CHAT);

  if (dryRun) {
    console.log(`[llm dry-run kind=${kind} toolMode=${toolMode}] prompt 长度:`, userPrompt.length);
    console.log("[llm dry-run] prompt 前 300 字:", userPrompt.slice(0, 300));
    if (kind === "self-loop") {
      return JSON.stringify({
        action: "silent",
        message: "",
        reasoning: "[dry-run mock] llm.js dry-run 模式，未真调 SDK",
        next_check_hint: "4_hours",
      });
    }
    return "[dry-run] 当前是 dry-run 模式，未真调 SDK。";
  }

  const freshSession = shouldUseClaudeFreshSession(kind, opts);
  const resumeId = freshSession ? null : loadSessionId(kind);
  const useFullTools = toolMode === TOOL_MODE_FULL;

  const sdkOptions = {
    model: LLM_MODEL,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: PROJECT_DIR,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    // 屏蔽 user-scope settings 源避免 Alice CLAUDE.md 工程规则污染 E-Twin 人格
    // 副作用：user-scope MCP servers 也跟着没了 → 用下面 mcpServers / allowedTools 单独补回
    settingSources: [],
    mcpServers: useFullTools ? ETWIN_MCP_SERVERS : {},
    allowedTools: useFullTools ? ETWIN_ALLOWED_TOOLS : [],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildSystemPrompt(toolMode),
    },
    // self-loop 单 turn 决策；reactive 留够 tool 调用空间。
    // 长文件审读 / 跨机查记录 / self-healing 会连续用工具，15 turns 偶发不够。
    maxTurns: resolveClaudeMaxTurns(kind),
    // SDK 子进程 stderr 转发到 etwin-bot stderr 方便排错
    stderr: (data) => process.stderr.write(`[SDK stderr] ${data}`),
  };
  console.log(`[claude] query kind=${kind} toolMode=${toolMode} model=${LLM_MODEL} tools=${useFullTools ? "full" : "chat"}`);

  if (LLM_EFFORT) sdkOptions.effort = LLM_EFFORT;
  if (resumeId) sdkOptions.resume = resumeId;

  let resultText = "";
  let observedSessionId = resumeId;

  try {
    for await (const ev of query({ prompt: userPrompt, options: sdkOptions })) {
      // system event 携带 session_id（新 session 时）
      if (ev.type === "system" && ev.session_id) {
        observedSessionId = ev.session_id;
      }
      // assistant message 累积文本
      if (ev.type === "assistant" && ev.message?.content) {
        const text = ev.message.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        resultText += text;
      }
      // result event 是收尾信号
      if (ev.type === "result") {
        // result.result 是最终汇总文本（fallback：如果 streaming 漏了）
        if (!resultText && ev.result) resultText = ev.result;
      }
    }
  } catch (err) {
    // resume 失败（thinking signature 过期 / session 被删等）→ 自动 fresh 重试一次
    if (resumeId && /invalid.*signature|invalid_request_error|session.*not.*found/i.test(err.message)) {
      console.warn(`[llm] resume sid=${resumeId.slice(0, 8)} 失败 (${err.message.slice(0, 80)})，新开 session 重试`);
      return await callClaudeSDK(userPrompt, { ...opts, fresh: true });
    }
    throw err;
  }

  if (!freshSession && observedSessionId && observedSessionId !== resumeId) {
    saveSessionId(kind, observedSessionId);
    console.log(`[llm] saved session_id kind=${kind} sid=${observedSessionId.slice(0, 8)}`);
  }

  return resultText;
}

// 解析 self-loop 的 JSON 输出（容错 markdown code fence）
export function parseDecisionJSON(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in LLM output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

// 兼容旧 API 名字
export const callMiniCC = callClaudeSDK;
