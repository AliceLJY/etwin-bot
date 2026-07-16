// self-loop.js — bot 周期性醒来，由 LLM 决定是否开口
// 常规节奏由 prompt + context 调节；操作者显式 /quiet 时由代码确定性拦截

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { gatherContext, loadActionLog, recentActions, interactionStats } from "./context.js";
import { callMiniCC, parseDecisionJSON } from "./llm.js";
import { PROJECT_DIR, dataPath, ensureRuntimeDirs, readPromptFile } from "./paths.js";
import { classifyReactionDelay, activeQuietUntil } from "./interaction.js";

ensureRuntimeDirs();

const ACTION_LOG = dataPath("action-log.json");
const SELF_DECISION_PROMPT_PATH = join(PROJECT_DIR, process.env.ETWIN_SELF_PROMPT || "prompts/self-decision.md");

// 唤醒间隔（仅是检查间隔，不是发送间隔——LLM 决定真发）
const WAKE_INTERVAL_MS = parseInt(process.env.ETWIN_WAKE_INTERVAL_MS || String(30 * 60 * 1000), 10);

function appendAction(action) {
  let log = [];
  if (existsSync(ACTION_LOG)) {
    try { log = JSON.parse(readFileSync(ACTION_LOG, "utf-8")); } catch (_) {}
  }
  log.push(action);
  // 留最近 200 条（足够 LLM 看历史）
  if (log.length > 200) log = log.slice(-200);
  writeFileSync(ACTION_LOG, JSON.stringify(log, null, 2));
}

// /quiet 落 action-log：command 不进 conversation-history，self-decision prompt 的
// "看 recent_conversation 里的 /quiet" 规则永远看不到它——必须写成结构化记录
export function recordQuietRequest(hours = 24) {
  appendAction({
    time: new Date().toISOString(),
    action: "quiet_request",
    quiet_until: new Date(Date.now() + hours * 3600_000).toISOString(),
    reasoning: `Alice 手动 /quiet，请安静 ${hours} 小时`,
  });
}


// 单次自我醒来：收 context → 喂 LLM → 拿决策 → 执行
export async function selfTick({ sendMessage, dryRun = false } = {}) {
  // 硬保证：Alice 手动 /quiet 未过期 → 直接 silent，不调 LLM（确定性 + 省 token）
  const quietUntil = activeQuietUntil(loadActionLog());
  if (quietUntil) {
    console.log(`[self-loop] 处于 /quiet 静默期至 ${quietUntil}，跳过本次 tick`);
    return null;
  }

  const context = await gatherContext();
  const actionLog48h = recentActions(48);
  const stats7d = interactionStats(7);

  // 拼 user prompt（system prompt 在 llm.js 里 buildSystemPrompt 拼好）
  const template = readPromptFile(SELF_DECISION_PROMPT_PATH);
  const userPrompt = template
    .replace("{{context_json}}", JSON.stringify(context, null, 2))
    .replace("{{action_log_json}}", JSON.stringify(actionLog48h, null, 2))
    .replace("{{interaction_stats_json}}", JSON.stringify(stats7d, null, 2));

  console.log(`[self-loop ${new Date().toISOString()}] 醒来检查...`);

  let llmOutput;
  try {
    // 关键：kind="self-loop" 让 self-loop 用独立 session，不污染 reactive session
    llmOutput = await callMiniCC(userPrompt, { dryRun, kind: "self-loop" });
  } catch (e) {
    console.error("[self-loop] LLM call failed:", e.message);
    appendAction({
      time: new Date().toISOString(),
      action: "error",
      error: e.message,
      reasoning: "LLM call failed",
    });
    return null;
  }

  let decision;
  try {
    decision = parseDecisionJSON(llmOutput);
  } catch (e) {
    console.error("[self-loop] 解析 JSON 失败:", e.message);
    console.error("[self-loop] LLM 原始输出:", llmOutput.slice(0, 500));
    appendAction({
      time: new Date().toISOString(),
      action: "error",
      error: "parse_decision_failed",
      raw: llmOutput.slice(0, 500),
    });
    return null;
  }

  console.log(`[self-loop] LLM 决策: action=${decision.action} reasoning="${decision.reasoning}"`);

  if (decision.action === "ping") {
    if (!decision.message || !decision.message.trim()) {
      console.warn("[self-loop] action=ping 但 message 为空，降级为 silent");
      appendAction({
        time: new Date().toISOString(),
        action: "silent",
        message: "",
        reasoning: `[本应 ping 但 message 空] ${decision.reasoning}`,
      });
      return null;
    }

    if (sendMessage && !dryRun) {
      try {
        await sendMessage(decision.message);
        appendAction({
          time: new Date().toISOString(),
          action: "ping",
          message: decision.message,
          reasoning: decision.reasoning,
          next_check_hint: decision.next_check_hint,
          alice_reaction: "unread",  // 后续 grammy on:message handler 会更新
        });
        console.log("[self-loop] ✓ 消息已发送");
      } catch (e) {
        console.error("[self-loop] sendMessage 失败:", e.message);
        appendAction({
          time: new Date().toISOString(),
          action: "error",
          error: `send_failed: ${e.message}`,
          intended_message: decision.message,
        });
      }
    } else {
      console.log("[self-loop dry-run] 不实际发送，消息内容:");
      console.log(decision.message);
      appendAction({
        time: new Date().toISOString(),
        action: "ping_dryrun",
        message: decision.message,
        reasoning: decision.reasoning,
      });
    }
  } else {
    // silent
    appendAction({
      time: new Date().toISOString(),
      action: "silent",
      message: "",
      reasoning: decision.reasoning,
      next_check_hint: decision.next_check_hint,
    });
    console.log("[self-loop] LLM 选择 silent，已记录");
  }

  return decision;
}

// 启动 self-loop
export function startSelfLoop({ sendMessage, dryRun = false, runOnStart = true } = {}) {
  console.log(`[self-loop] 启动 — interval=${WAKE_INTERVAL_MS}ms dryRun=${dryRun} runOnStart=${runOnStart}`);

  // 启动 30 秒后跑第一次（让 bot 稳定，也不用等完整配置间隔看效果）
  // LLM 自己看 context 决定要不要 ping，可能 silent 也可能 hello
  if (runOnStart) {
    setTimeout(() => {
      console.log("[self-loop] 启动后第一次 tick");
      selfTick({ sendMessage, dryRun }).catch((e) => {
        console.error("[self-loop] initial tick 异常:", e);
      });
    }, 30000);
  }

  return setInterval(() => {
    selfTick({ sendMessage, dryRun }).catch((e) => {
      console.error("[self-loop] tick 异常:", e);
    });
  }, WAKE_INTERVAL_MS);
}

// 标记某条 ping 的 Alice 反应（由 bot.js handleMessage 调用）。
// 反应等级按"她回得多快"自动判定，而非一律 engaged——让 interactionStats 拿到真数据。
export function markAliceReaction({ withinHours = 24 } = {}) {
  let log = [];
  if (existsSync(ACTION_LOG)) {
    try { log = JSON.parse(readFileSync(ACTION_LOG, "utf-8")); } catch (_) {}
  }
  const now = Date.now();
  const cutoff = now - withinHours * 3600_000;
  // 找最近一条 ping 且 reaction 还是 unread 的
  for (let i = log.length - 1; i >= 0; i--) {
    const a = log[i];
    if (a.action !== "ping") continue;
    const pingTime = new Date(a.time).getTime();
    if (pingTime < cutoff) break;
    if (a.alice_reaction === "unread") {
      a.alice_reaction = classifyReactionDelay(now - pingTime);
      writeFileSync(ACTION_LOG, JSON.stringify(log, null, 2));
      return a.alice_reaction;
    }
  }
  return null;
}
