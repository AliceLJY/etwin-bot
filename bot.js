#!/usr/bin/env bun
// bot.js — etwin-bot 主入口
// grammy reactive 对话 + self-loop proactive 自驱

import { Bot, GrammyError } from "grammy";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { callMiniCC } from "./llm.js";
import { gatherContext } from "./context.js";
import { startSelfLoop, markAliceReaction } from "./self-loop.js";

const PROJECT_DIR = import.meta.dir;
const REPLY_PROMPT_PATH = join(PROJECT_DIR, "prompts/reply.md");
const CONV_HISTORY_PATH = join(PROJECT_DIR, "data/conversation-history.json");

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const ALICE_CHAT_ID = process.env.ALICE_CHAT_ID;
const DRY_RUN = process.env.ETWIN_DRY_RUN === "true";
const PROACTIVE_ENABLED = process.env.ETWIN_PROACTIVE !== "false";

// 段间延迟参数：模拟真人打字节奏
const TYPING_MS_PER_CHAR = parseInt(process.env.ETWIN_TYPING_MS_PER_CHAR || "40", 10);
const TYPING_MAX_MS = parseInt(process.env.ETWIN_TYPING_MAX_MS || "3500", 10);
const TYPING_JITTER_MS = parseInt(process.env.ETWIN_TYPING_JITTER_MS || "800", 10);

// 把 LLM 输出按双换行切成多条 TG 消息
function splitMessages(text) {
  if (!text) return [];
  return text.split(/\n{2,}/).map((s) => s.trim()).filter((s) => s.length > 0);
}

// 模拟真人节奏：typing indicator + 段间延迟逐条发
async function sendAsMulti({ bot, chatId, text }) {
  const segments = splitMessages(text);
  if (segments.length === 0) return;

  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      // 段间延迟基于上一段长度（每字符 40ms，上限 3.5s）+ 0-800ms 随机
      const prev = segments[i - 1];
      const baseDelay = Math.min(prev.length * TYPING_MS_PER_CHAR, TYPING_MAX_MS);
      const jitter = Math.random() * TYPING_JITTER_MS;
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }
    // 显示 typing 让用户看到"对方在输入"
    try { await bot.api.sendChatAction(chatId, "typing"); } catch (_) {}
    // 短停顿让 typing indicator 浮现
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
    await bot.api.sendMessage(chatId, segments[i]);
  }
}

if (!TG_BOT_TOKEN) {
  console.error("❌ 缺 TG_BOT_TOKEN env，看 .env.example 配置");
  process.exit(1);
}
if (!ALICE_CHAT_ID) {
  console.error("❌ 缺 ALICE_CHAT_ID env，先 /start 给 bot 一次，看 stderr 拿你的 chat ID");
}

// 维护对话历史（最近 N 轮）
function loadHistory() {
  if (!existsSync(CONV_HISTORY_PATH)) return [];
  try { return JSON.parse(readFileSync(CONV_HISTORY_PATH, "utf-8")); } catch (_) { return []; }
}
function saveHistory(history) {
  // 留最近 30 轮
  const trimmed = history.slice(-60);
  writeFileSync(CONV_HISTORY_PATH, JSON.stringify(trimmed, null, 2));
}

const bot = new Bot(TG_BOT_TOKEN);

// /start 命令：让 bot 报自己 chat ID 方便配置
bot.command("start", async (ctx) => {
  await ctx.reply(
    `你好，I 化的你。我是 E-Twin。\n\n` +
    `Chat ID: \`${ctx.chat.id}\` — 把这个填到 .env 的 ALICE_CHAT_ID。\n` +
    `配完重启 bot，我就能找你聊天了。`,
    { parse_mode: "Markdown" },
  );
  console.log(`[bot] 收到 /start chat_id=${ctx.chat.id}`);
});

// /quiet 命令：紧急静默（虽然 LLM 自己会判断，但留个手动 escape）
bot.command("quiet", async (ctx) => {
  await ctx.reply("好。我安静一会儿。");
  // 写一条 silent_override action，让 LLM 下次醒来看到
  console.log(`[bot] /quiet from chat ${ctx.chat.id}`);
});

// 所有 text 消息：reactive 对话
bot.on("message:text", async (ctx) => {
  // 仅响应 Alice
  if (ALICE_CHAT_ID && String(ctx.chat.id) !== String(ALICE_CHAT_ID)) {
    console.log(`[bot] 忽略非 Alice 的消息 chat_id=${ctx.chat.id}`);
    return;
  }

  const userMsg = ctx.message.text;
  console.log(`[bot] Alice → bot: ${userMsg.slice(0, 100)}`);

  // 更新 self-loop 的 alice_reaction：她在回复 = engaged
  markAliceReaction({ withinHours: 24 }, "engaged");

  // 记录对话历史
  const history = loadHistory();
  history.push({ role: "user", content: userMsg, time: new Date().toISOString() });

  try {
    // 显示 typing
    await ctx.replyWithChatAction("typing");

    const context = await gatherContext();
    const template = readFileSync(REPLY_PROMPT_PATH, "utf-8");
    const recentHistory = history.slice(-20);
    const userPrompt = template
      .replace("{{context_json}}", JSON.stringify(context, null, 2))
      .replace("{{user_message}}", userMsg)
      .replace("{{conversation_history}}", JSON.stringify(recentHistory, null, 2));

    if (DRY_RUN) {
      console.log("[bot dry-run] 不实际调 LLM");
      await ctx.reply("[dry-run] 当前是 dry-run 模式，未真调 mini CC。");
      return;
    }

    const reply = await callMiniCC(userPrompt);

    history.push({ role: "assistant", content: reply, time: new Date().toISOString() });
    saveHistory(history);

    // 按 \n\n 切多条 + typing 节奏发送（像真人聊天）
    await sendAsMulti({ bot, chatId: ctx.chat.id, text: reply });
    const segCount = splitMessages(reply).length;
    console.log(`[bot] bot → Alice: ${segCount} 段, 首段: ${reply.slice(0, 80)}`);
  } catch (e) {
    console.error("[bot] reply 失败:", e.message);
    try {
      await ctx.reply(`唉，我那边出了点问题：${e.message.slice(0, 200)}\n（这条不算 E-Twin 的话，是 plumbing error）`);
    } catch (_) {}
  }
});

bot.catch((err) => {
  if (err instanceof GrammyError) {
    console.error("[bot] grammy error:", err.message);
  } else {
    console.error("[bot] unexpected error:", err);
  }
});

// 启动
async function main() {
  console.log("=== etwin-bot 启动 ===");
  console.log(`DRY_RUN=${DRY_RUN}`);
  console.log(`PROACTIVE_ENABLED=${PROACTIVE_ENABLED}`);
  console.log(`ALICE_CHAT_ID=${ALICE_CHAT_ID || "(未配置)"}`);

  // 启动 self-loop（如果开启 + 已配置 chat ID）
  if (PROACTIVE_ENABLED && ALICE_CHAT_ID) {
    startSelfLoop({
      sendMessage: async (text) => {
        // proactive 主动 push 同样走多段发送，保持真人节奏
        await sendAsMulti({ bot, chatId: ALICE_CHAT_ID, text });
      },
      dryRun: DRY_RUN,
    });
  } else if (!PROACTIVE_ENABLED) {
    console.log("[main] ETWIN_PROACTIVE=false，self-loop 不启动（纯 reactive 模式）");
  } else {
    console.log("[main] 缺 ALICE_CHAT_ID，self-loop 暂不启动；先 /start 拿 chat ID");
  }

  // 启动 bot
  await bot.start({
    onStart: (botInfo) => {
      console.log(`[bot] @${botInfo.username} 已上线`);
    },
  });
}

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
