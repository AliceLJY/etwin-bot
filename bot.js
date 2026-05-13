#!/usr/bin/env bun
// bot.js — etwin-bot 主入口
// grammy reactive 对话 + self-loop proactive 自驱

import { Bot, GrammyError } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from "fs";
import { join } from "path";
import { callMiniCC } from "./llm.js";
import { gatherContext } from "./context.js";
import { startSelfLoop, markAliceReaction } from "./self-loop.js";

// 下载 TG 文件到本地（参考 telegram-ai-bridge bridge.js downloadFile）
const FILE_DIR = join(import.meta.dir, "files");
mkdirSync(FILE_DIR, { recursive: true });

// 启动时清理 30+ 天前的旧文件
(function cleanupOldFiles() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    const trash = join(process.env.HOME || "/Users/anxianjingya", ".Trash");
    let moved = 0;
    for (const f of readdirSync(FILE_DIR)) {
      try {
        const p = join(FILE_DIR, f);
        if (statSync(p).mtimeMs < cutoff) {
          renameSync(p, join(trash, `etwin-bot-${Date.now()}-${f}`));
          moved++;
        }
      } catch (_) {}
    }
    if (moved > 0) console.log(`[startup-cleanup] 移走 ${moved} 个 30+ 天前文件`);
  } catch (_) {}
})();

async function downloadTGFile(ctx, fileId, filename) {
  const file = await ctx.api.getFile(fileId);
  const TOKEN = process.env.TG_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy;
  const resp = PROXY
    ? await fetch(url, { agent: new HttpsProxyAgent(PROXY) })
    : await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const localPath = join(FILE_DIR, `${Date.now()}-${filename}`);
  writeFileSync(localPath, buffer);
  return localPath;
}

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

// 图片：下载到本地 + prompt 里塞绝对路径让 LLM 自己 Read 看
bot.on("message:photo", async (ctx) => {
  if (ALICE_CHAT_ID && String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
  const photo = ctx.message.photo;
  const largest = photo[photo.length - 1];
  const caption = ctx.message.caption || "看看这张图";
  try {
    const localPath = await downloadTGFile(ctx, largest.file_id, "photo.jpg");
    console.log(`[bot] Alice → bot: [photo] ${localPath}`);
    await handleMessage(ctx, `${caption}\n\n[图片文件: ${localPath}]`);
  } catch (e) {
    await ctx.reply(`图片下载失败: ${e.message}`);
  }
});

// 文档：同图片处理
bot.on("message:document", async (ctx) => {
  if (ALICE_CHAT_ID && String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
  const doc = ctx.message.document;
  const caption = ctx.message.caption || `看看这个文件: ${doc.file_name}`;
  if (doc.file_size > 20 * 1024 * 1024) {
    await ctx.reply("文件太大（超过 20MB），TG Bot API 限制。");
    return;
  }
  try {
    const localPath = await downloadTGFile(ctx, doc.file_id, doc.file_name || "file");
    console.log(`[bot] Alice → bot: [document] ${localPath}`);
    await handleMessage(ctx, `${caption}\n\n[文件: ${localPath}]`);
  } catch (e) {
    await ctx.reply(`文件下载失败: ${e.message}`);
  }
});

// 语音：下载传给 CC，让 CC 用 Read tool 看（CC 能识别音频）
bot.on("message:voice", async (ctx) => {
  if (ALICE_CHAT_ID && String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
  try {
    const localPath = await downloadTGFile(ctx, ctx.message.voice.file_id, "voice.ogg");
    console.log(`[bot] Alice → bot: [voice] ${localPath}`);
    await handleMessage(ctx, `[语音文件: ${localPath}] 听听这段语音再回我`);
  } catch (e) {
    await ctx.reply(`语音下载失败: ${e.message}`);
  }
});

// Sticker handler：Alice 发 sticker → bot 抓 file_id 存到 sticker 库
// Phase 1: 只存不发回——攒到 30-50 个后再做 LLM 选 sticker 那一层
const STICKER_LIB = join(import.meta.dir, "data/sticker-library.json");
function loadStickerLib() {
  if (!existsSync(STICKER_LIB)) return [];
  try { return JSON.parse(readFileSync(STICKER_LIB, "utf-8")); } catch (_) { return []; }
}
function saveStickerLib(lib) {
  writeFileSync(STICKER_LIB, JSON.stringify(lib, null, 2));
}

bot.on("message:sticker", async (ctx) => {
  if (ALICE_CHAT_ID && String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
  const s = ctx.message.sticker;
  const lib = loadStickerLib();
  // 去重：相同 file_unique_id 只记 1 次但增加 used_count
  const existing = lib.find((x) => x.file_unique_id === s.file_unique_id);
  if (existing) {
    existing.alice_used_count = (existing.alice_used_count || 1) + 1;
    existing.last_used = new Date().toISOString();
  } else {
    lib.push({
      file_id: s.file_id,
      file_unique_id: s.file_unique_id,
      emoji: s.emoji || "",
      set_name: s.set_name || "",
      is_animated: !!s.is_animated,
      is_video: !!s.is_video,
      width: s.width,
      height: s.height,
      first_seen: new Date().toISOString(),
      last_used: new Date().toISOString(),
      alice_used_count: 1,
    });
  }
  saveStickerLib(lib);
  console.log(`[bot] Alice 发 sticker 已记入库 emoji=${s.emoji || "?"} set=${s.set_name || "?"} 库总数=${lib.length}`);

  // bot 也通过 reactive 通路回一条——但让 LLM 知道刚收到一个 sticker
  // 而不是只是 silent ignore
  await handleMessage(ctx, `[Alice 发了一个表情包 emoji=${s.emoji || "未知"} set=${s.set_name || "未知"}] 自然回应一下，不要刻板描述"我看到你发了个表情包"——就当你看到这个表情符号的真情绪`);
});

// 统一处理（reply.md 路径），text/photo/document/voice 都走这里
async function handleMessage(ctx, userMsg) {
  // 更新 self-loop 的 alice_reaction
  markAliceReaction({ withinHours: 24 }, "engaged");

  const history = loadHistory();
  history.push({ role: "user", content: userMsg, time: new Date().toISOString() });

  try {
    await ctx.replyWithChatAction("typing");

    const context = await gatherContext();
    const template = readFileSync(REPLY_PROMPT_PATH, "utf-8");
    const recentHistory = history.slice(-20);
    const userPrompt = template
      .replace("{{context_json}}", JSON.stringify(context, null, 2))
      .replace("{{user_message}}", userMsg)
      .replace("{{conversation_history}}", JSON.stringify(recentHistory, null, 2));

    if (DRY_RUN) {
      await ctx.reply("[dry-run] 当前是 dry-run 模式，未真调 LLM。");
      return;
    }

    const reply = await callMiniCC(userPrompt);
    history.push({ role: "assistant", content: reply, time: new Date().toISOString() });
    saveHistory(history);

    await sendAsMulti({ bot, chatId: ctx.chat.id, text: reply });
    const segCount = splitMessages(reply).length;
    console.log(`[bot] bot → Alice: ${segCount} 段, 首段: ${reply.slice(0, 80)}`);
  } catch (e) {
    console.error("[bot] reply 失败:", e.message);
    try {
      await ctx.reply(`唉，我那边出了点问题：${e.message.slice(0, 200)}\n（这条不算 E-Twin 的话，是 plumbing error）`);
    } catch (_) {}
  }
}

// 所有 text 消息：reactive 对话
bot.on("message:text", async (ctx) => {
  // 仅响应 Alice
  if (ALICE_CHAT_ID && String(ctx.chat.id) !== String(ALICE_CHAT_ID)) {
    console.log(`[bot] 忽略非 Alice 的消息 chat_id=${ctx.chat.id}`);
    return;
  }

  await handleMessage(ctx, ctx.message.text);
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
