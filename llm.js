// llm.js — Claude Agent SDK 调用 + session resume 让 cache 复用
// 取代旧版的 spawn `claude -p` 子进程模式

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const PROJECT_DIR = import.meta.dir;
const SESSION_STORE = join(PROJECT_DIR, "data/session-ids.json");

// SDK 0.2.117+ 砍掉了内置 cli.js，必须显式传 claude CLI 路径
const CLAUDE_CLI_PATH =
  process.env.CLAUDE_CLI_PATH || join(homedir(), ".local/bin/claude");

const LLM_MODEL = process.env.ETWIN_LLM_MODEL || "claude-sonnet-4-6";
const LLM_EFFORT = process.env.ETWIN_LLM_EFFORT || null; // 不指定走默认

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

// E-Twin 该有的 MCP：
// - playwright: 抓 SPA / 动态渲染页面（claude.ai/share、小红书等）
// - recallnest: read-only recall Alice 记忆，让 E-Twin 真像 Alice 的分身
const ETWIN_MCP_SERVERS = {
  // playwright 通过 plugin 加载不在 ~/.claude.json，直接显式注入
  playwright: {
    command: "npx",
    args: ["@playwright/mcp@latest"],
  },
  // recallnest 在 user-scope，复用配置（含 JINA_API_KEY / ssh mini）
  ...loadUserScopeMcpServers(["recallnest"]),
};

// 白名单：抓网页 + recall 记忆 + 读自己的 persona/data
// 不放：Write/Edit/Bash/Task/NotebookEdit（产生持久副作用或能套娃）
// 不放：mcp__recallnest__store_memory 等写操作（read-only 起步，避免污染 Alice RN）
const ETWIN_ALLOWED_TOOLS = [
  "WebFetch",            // HTTP fast-path，普通页面优先走这条
  "Read",                // 让 E-Twin 读自己 persona/data 目录
  "Grep",
  "Glob",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_close",
  "mcp__playwright__browser_wait_for",
  "mcp__playwright__browser_evaluate",
  "mcp__recallnest__resume_context",
  "mcp__recallnest__search_memory",
  "mcp__recallnest__brief_memory",
  "mcp__recallnest__retrieve_skill",
];

// 读 persona 三件套 + 追加 long-term-memory 拼成 system prompt append
export function buildSystemPrompt() {
  const base = readFileSync(join(PROJECT_DIR, "persona/digital-clone-base.md"), "utf-8");
  const profile = readFileSync(join(PROJECT_DIR, "persona/digital-clone-profile.md"), "utf-8");
  const tuning = readFileSync(join(PROJECT_DIR, "persona/e-tuning.md"), "utf-8");

  // long-term memory 注入（每次 distill 后自动累积）
  let memorySection = "";
  const memPath = join(PROJECT_DIR, "data/long-term-memory.json");
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

  return `${base}\n\n---\n\n${profile}\n\n---\n\n${tuning}${memorySection}`;
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
  const dryRun = opts.dryRun || process.env.ETWIN_DRY_RUN === "true";
  const kind = opts.kind || "reactive";

  if (dryRun) {
    console.log(`[llm dry-run kind=${kind}] prompt 长度:`, userPrompt.length);
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

  const resumeId = opts.fresh ? null : loadSessionId(kind);

  const sdkOptions = {
    model: LLM_MODEL,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: PROJECT_DIR,
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
    // 屏蔽 user-scope settings 源避免 Alice CLAUDE.md 工程规则污染 E-Twin 人格
    // 副作用：user-scope MCP servers 也跟着没了 → 用下面 mcpServers / allowedTools 单独补回
    settingSources: [],
    mcpServers: ETWIN_MCP_SERVERS,
    allowedTools: ETWIN_ALLOWED_TOOLS,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildSystemPrompt(),
    },
    // self-loop 单 turn 决策；reactive 留够 tool 调用空间
    // 抓 SPA 路径：navigate → snapshot → close = 3 turn 起，加 recall 记忆 + 文本回复就 5+
    maxTurns: kind === "self-loop" ? 1 : 8,
    // SDK 子进程 stderr 转发到 etwin-bot stderr 方便排错
    stderr: (data) => process.stderr.write(`[SDK stderr] ${data}`),
  };

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

  if (observedSessionId && observedSessionId !== resumeId) {
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
