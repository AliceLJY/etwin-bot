#!/usr/bin/env bun
// bot.js — etwin-bot 主入口
// grammy reactive 对话 + self-loop proactive 自驱

import { Bot, GrammyError } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { homedir } from "os";
import { callMiniCC } from "./llm.js";
import { generateTelegramImage } from "./image-generation.js";
import { gatherContext } from "./context.js";
import { startSelfLoop, markAliceReaction, recordQuietRequest } from "./self-loop.js";
import { shouldDistill, runDistill } from "./distill.js";
import { FILE_DIR, INSTANCE_ID, PROJECT_DIR, dataPath, ensureRuntimeDirs, readPromptFile } from "./paths.js";
import { splitMessages } from "./message-split.js";
import { TOOL_MODE_FULL, isImageFollowupRequest, isImageGenerationRequest, resolveToolMode } from "./tool-mode.js";
import { createInboundFilePath } from "./runtime-files.js";

// 下载 TG 文件到本地（参考 telegram-ai-bridge bridge.js downloadFile）
ensureRuntimeDirs();

// 启动时清理 30+ 天前的旧文件
(function cleanupOldFiles() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  try {
    const trash = join(homedir(), ".Trash");
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
  const localPath = createInboundFilePath(FILE_DIR, filename);
  writeFileSync(localPath, buffer, { flag: "wx", mode: 0o600 });
  return localPath;
}

const DEFAULT_REPLY_PROMPT =
  process.env.ETWIN_PERSONA === "codex" ? "prompts/reply-codex.md" : "prompts/reply.md";
const REPLY_PROMPT_PATH = join(PROJECT_DIR, process.env.ETWIN_REPLY_PROMPT || DEFAULT_REPLY_PROMPT);
const CONV_HISTORY_PATH = dataPath("conversation-history.json");
const PENDING_MEDIA_PATH = dataPath("pending-media.json");

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const ALICE_CHAT_ID = process.env.ALICE_CHAT_ID;
const DRY_RUN = process.env.ETWIN_DRY_RUN === "true";
const PROACTIVE_ENABLED = process.env.ETWIN_PROACTIVE !== "false";
const RUN_ON_START = process.env.ETWIN_RUN_ON_START !== "false";
const BOT_DISPLAY_NAME = process.env.ETWIN_DISPLAY_NAME || (INSTANCE_ID === "codex" ? "Codex Twin" : "E-Twin");

function parseIntegerEnv(value, fallback, min = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

// 段间延迟参数：模拟真人打字节奏
const TYPING_MS_PER_CHAR = parseInt(process.env.ETWIN_TYPING_MS_PER_CHAR || "40", 10);
const TYPING_MAX_MS = parseInt(process.env.ETWIN_TYPING_MAX_MS || "3500", 10);
const TYPING_JITTER_MS = parseInt(process.env.ETWIN_TYPING_JITTER_MS || "800", 10);
const TYPING_KEEPALIVE_MS = parseInt(process.env.ETWIN_TYPING_KEEPALIVE_MS || "4500", 10);
const REACTIVE_HISTORY_LIMIT = parseIntegerEnv(process.env.ETWIN_REACTIVE_HISTORY_LIMIT, 20, 1);
const REACTIVE_STALL_NOTICE_MS = parseIntegerEnv(process.env.ETWIN_REACTIVE_STALL_NOTICE_MS, 0, 0);
const REACTIVE_STALL_NOTICE_TEXT = process.env.ETWIN_REACTIVE_STALL_NOTICE_TEXT || "我还在，刚才这一轮有点慢，不是你发丢了。";

// 区分"基础设施抖动"(LLM 超时 / 子进程被重启杀掉)和真正的代码 bug。
// 前者不把 SIGTERM / timed out 这种技术黑话弹给 Alice（破坏跟分身对话的沉浸感），
// 后者保留 plumbing error 细节方便排查。
function friendlyErrorReply(e, displayName) {
  const msg = e?.message || "";
  if (/timed out|SIGTERM|SIGKILL|terminated by|exited \d+ after|returned empty/i.test(msg)) {
    return "我刚卡了一下，没接住你这句。你再发一遍，我马上回。";
  }
  return `唉，我那边出了点问题：${msg.slice(0, 200)}\n（这条不算 ${displayName} 的话，是 plumbing error）`;
}

// 把 LLM 输出按双换行切成多条 TG 消息
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

function sendPhotoViaCurl(chatId, imagePath) {
  return new Promise((resolve, reject) => {
    const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    const args = ["-sS", "--fail-with-body"];
    if (PROXY) args.push("-x", PROXY);
    args.push(
      "-F", `chat_id=${chatId}`,
      "-F", `photo=@${imagePath}`,
      "--config", "-",
    );

    const child = spawn("curl", args, {
      cwd: PROJECT_DIR,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`telegram sendPhoto failed with curl exit ${code}: ${stderr.slice(-800) || stdout.slice(-800)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.ok) {
          reject(new Error(`telegram sendPhoto API failed: ${stdout.slice(0, 800)}`));
          return;
        }
        resolve(result.result);
      } catch (err) {
        reject(new Error(`telegram sendPhoto returned non-JSON: ${stdout.slice(0, 800) || err.message}`));
      }
    });
    child.stdin.end(`url = "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto"\n`);
  });
}

function startTypingKeepalive(ctx) {
  if (!Number.isFinite(TYPING_KEEPALIVE_MS) || TYPING_KEEPALIVE_MS <= 0) return () => {};
  const timer = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, TYPING_KEEPALIVE_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

function startUploadPhotoKeepalive(ctx) {
  const intervalMs = Number.isFinite(TYPING_KEEPALIVE_MS) && TYPING_KEEPALIVE_MS > 0 ? TYPING_KEEPALIVE_MS : 4500;
  const timer = setInterval(() => {
    ctx.replyWithChatAction("upload_photo").catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

function startStallNotice(ctx) {
  if (!Number.isFinite(REACTIVE_STALL_NOTICE_MS) || REACTIVE_STALL_NOTICE_MS <= 0) return () => {};
  const timer = setTimeout(() => {
    ctx.reply(REACTIVE_STALL_NOTICE_TEXT).catch(() => {});
  }, REACTIVE_STALL_NOTICE_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

if (!TG_BOT_TOKEN) {
  console.error("❌ 缺 TG_BOT_TOKEN env，看 .env.example 配置");
  process.exit(1);
}
if (!ALICE_CHAT_ID) {
  // fail-closed：full 工具模式 + bypassPermissions 下，未锁定聊天对象等于把本机 shell 开给任何 TG 用户
  if (DRY_RUN) {
    console.error("⚠️ 缺 ALICE_CHAT_ID env（dry-run 继续跑：给 bot 发 /start 拿 chat ID，填入 env 后正式启动）");
  } else {
    console.error("❌ 缺 ALICE_CHAT_ID env，拒绝启动。先 ETWIN_DRY_RUN=true 起 bot，/start 拿 chat ID 填进 env 再来。");
    process.exit(1);
  }
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

function hasRecentImageGenerationContext(history) {
  return history.slice(-10).some((item) => {
    const content = String(item.content || "");
    return content.includes("[生成图片:") || isImageGenerationRequest(content);
  });
}

function composeImageRequest(message, history) {
  const current = String(message || "");
  if (isImageGenerationRequest(current)) return current;

  let contextStart = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const content = String(history[i].content || "");
    if (isImageGenerationRequest(content) || content.includes("[生成图片:")) {
      contextStart = i;
      break;
    }
  }
  if (contextStart === -1) return current;

  const imageContext = history.slice(Math.max(0, contextStart - 4), history.length)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");

  return `${imageContext}\n\n当前修改/追问：${current}`;
}

function hasCompletedSameImageRequest(message, history) {
  const current = String(message || "");
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.role !== "user" || String(item.content || "") !== current) continue;
    return history.slice(i + 1).some((later) => (
      later.role === "assistant" && String(later.content || "").includes("[生成图片:")
    ));
  }
  return false;
}

async function buildReactivePromptContext(toolMode) {
  if (toolMode === TOOL_MODE_FULL) {
    const context = await gatherContext();
    const promptContext = { ...context };
    delete promptContext.recent_conversation;
    return promptContext;
  }

  const now = new Date();
  return {
    time_now: now.toISOString(),
    hour_of_day: now.getHours(),
  };
}

function loadPendingMedia() {
  if (!existsSync(PENDING_MEDIA_PATH)) return {};
  try { return JSON.parse(readFileSync(PENDING_MEDIA_PATH, "utf-8")); } catch (_) { return {}; }
}

function savePendingMedia(data) {
  writeFileSync(PENDING_MEDIA_PATH, JSON.stringify(data, null, 2));
}

function stashPendingImage(chatId, imagePath) {
  const data = loadPendingMedia();
  const key = String(chatId);
  const cutoff = Date.now() - 10 * 60 * 1000;
  const current = (data[key] || []).filter((m) => new Date(m.time).getTime() > cutoff);
  current.push({ type: "image", path: imagePath, time: new Date().toISOString() });
  data[key] = current.slice(-5);
  savePendingMedia(data);
}

function consumePendingImages(chatId) {
  const data = loadPendingMedia();
  const key = String(chatId);
  const cutoff = Date.now() - 10 * 60 * 1000;
  const images = (data[key] || [])
    .filter((m) => m.type === "image" && new Date(m.time).getTime() > cutoff)
    .map((m) => m.path);
  delete data[key];
  savePendingMedia(data);
  return images;
}

const bot = new Bot(TG_BOT_TOKEN);

// /start 命令：让 bot 报自己 chat ID 方便配置
bot.command("start", async (ctx) => {
  await ctx.reply(
    `你好，我是 ${BOT_DISPLAY_NAME}。\n\n` +
    `Chat ID: \`${ctx.chat.id}\` — 把这个填到当前 env 的 ALICE_CHAT_ID。\n` +
    `配完重启 bot，我就能找你聊天了。`,
    { parse_mode: "Markdown" },
  );
  console.log(`[bot] 收到 /start chat_id=${ctx.chat.id}`);
});

// /quiet 命令：紧急静默。写一条 quiet_request 进 action-log——
// selfTick 下次醒来会硬拦截（不调 LLM 直接 silent），不再是只回一句空话的假按钮。
bot.command("quiet", async (ctx) => {
  if (!ALICE_CHAT_ID || String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
  recordQuietRequest(24);
  await ctx.reply("好。我安静一会儿，24 小时内不主动找你；你随时叫我就回来。");
  console.log(`[bot] /quiet from chat ${ctx.chat.id} → 静默 24h 已记入 action-log`);
});

// 图片：下载到本地；有 caption 立即处理，无 caption 等 Alice 下一条文字一起看
bot.on("message:photo", async (ctx) => {
  if (!ALICE_CHAT_ID || String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
  const photo = ctx.message.photo;
  const largest = photo[photo.length - 1];
  const caption = ctx.message.caption?.trim() || "";
  try {
    const localPath = await downloadTGFile(ctx, largest.file_id, "photo.jpg");
    console.log(`[bot] Alice → bot: [photo] ${localPath}`);
    if (!caption) {
      stashPendingImage(ctx.chat.id, localPath);
      await ctx.reply("图我收到了，你补一句问题我一起看。");
      return;
    }
    await handleMessage(ctx, `${caption}\n\n[图片文件: ${localPath}]`, { images: [localPath] });
  } catch (e) {
    await ctx.reply(`图片下载失败: ${e.message}`);
  }
});

// 文档：同图片处理
bot.on("message:document", async (ctx) => {
  if (!ALICE_CHAT_ID || String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
  const doc = ctx.message.document;
  const caption = ctx.message.caption || `看看这个文件: ${doc.file_name}`;
  if (doc.file_size > 20 * 1024 * 1024) {
    await ctx.reply("文件太大（超过 20MB），TG Bot API 限制。");
    return;
  }
  try {
    const localPath = await downloadTGFile(ctx, doc.file_id, doc.file_name || "file");
    console.log(`[bot] Alice → bot: [document] ${localPath}`);
    const images = doc.mime_type?.startsWith("image/") ? [localPath] : [];
    await handleMessage(ctx, `${caption}\n\n[文件: ${localPath}]`, { images });
  } catch (e) {
    await ctx.reply(`文件下载失败: ${e.message}`);
  }
});

// 语音：下载传给 CC，让 CC 用 Read tool 看（CC 能识别音频）
bot.on("message:voice", async (ctx) => {
  if (!ALICE_CHAT_ID || String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
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
const STICKER_LIB = dataPath("sticker-library.json");
function loadStickerLib() {
  if (!existsSync(STICKER_LIB)) return [];
  try { return JSON.parse(readFileSync(STICKER_LIB, "utf-8")); } catch (_) { return []; }
}
function saveStickerLib(lib) {
  writeFileSync(STICKER_LIB, JSON.stringify(lib, null, 2));
}

bot.on("message:sticker", async (ctx) => {
  if (!ALICE_CHAT_ID || String(ctx.chat.id) !== String(ALICE_CHAT_ID)) return;
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
async function handleMessage(ctx, userMsg, opts = {}) {
  // 更新 self-loop 的 alice_reaction（按回应延迟自动分级 engaged/delayed）
  markAliceReaction({ withinHours: 24 });

  const toolModeRequest = resolveToolMode(userMsg);
  const normalizedUserMsg = toolModeRequest.message || userMsg;
  const priorHistory = loadHistory();
  const history = [...priorHistory];
  history.push({ role: "user", content: normalizedUserMsg, time: new Date().toISOString() });
  let stopWaitingTyping = () => {};
  let stopStallNotice = () => {};

  try {
    const shouldGenerateImage = (opts.images || []).length === 0 && (
      isImageGenerationRequest(normalizedUserMsg) ||
      (hasRecentImageGenerationContext(priorHistory) && isImageFollowupRequest(normalizedUserMsg))
    );

    console.log(`[bot] route text="${normalizedUserMsg.slice(0, 80)}" toolMode=${toolModeRequest.mode} source=${toolModeRequest.source} image=${shouldGenerateImage}`);

    if (shouldGenerateImage) {
      if (hasCompletedSameImageRequest(normalizedUserMsg, priorHistory)) {
        console.log(`[bot] duplicate image request already completed, ack only text="${normalizedUserMsg.slice(0, 80)}"`);
        saveHistory(history);
        return;
      }

      await ctx.replyWithChatAction("upload_photo");
      stopWaitingTyping = startUploadPhotoKeepalive(ctx);
      stopStallNotice = startStallNotice(ctx);

      const image = await generateTelegramImage(composeImageRequest(normalizedUserMsg, priorHistory));
      stopWaitingTyping();
      stopStallNotice();

      const sent = await sendPhotoViaCurl(ctx.chat.id, image.path);
      history.push({ role: "assistant", content: `[生成图片: ${image.path}]`, time: new Date().toISOString() });
      saveHistory(history);
      console.log(`[bot] bot → Alice: [photo] ${image.path} message_id=${sent.message_id}`);
      return;
    }

    await ctx.replyWithChatAction("typing");
    stopWaitingTyping = startTypingKeepalive(ctx);
    stopStallNotice = startStallNotice(ctx);

    const promptContext = await buildReactivePromptContext(toolModeRequest.mode);
    const template = readPromptFile(REPLY_PROMPT_PATH);
    const recentHistory = history.slice(-REACTIVE_HISTORY_LIMIT);
    const userPrompt = template
      .replace("{{context_json}}", JSON.stringify(promptContext, null, 2))
      .replace("{{user_message}}", normalizedUserMsg)
      .replace("{{conversation_history}}", JSON.stringify(recentHistory, null, 2));

    if (DRY_RUN) {
      stopWaitingTyping();
      stopStallNotice();
      await ctx.reply("[dry-run] 当前是 dry-run 模式，未真调 LLM。");
      return;
    }

    // 显式 kind="reactive" 避免和 self-loop 串台
    const reply = await callMiniCC(userPrompt, { kind: "reactive", images: opts.images || [], toolMode: toolModeRequest.mode });
    stopWaitingTyping();
    stopStallNotice();
    history.push({ role: "assistant", content: reply, time: new Date().toISOString() });
    saveHistory(history);

    await sendAsMulti({ bot, chatId: ctx.chat.id, text: reply });
    const segCount = splitMessages(reply).length;
    console.log(`[bot] bot → Alice: ${segCount} 段, 首段: ${reply.slice(0, 80)}`);

    // 回复完成后检查是否需要 distill（后台跑不阻塞）
    if (shouldDistill()) {
      console.log("[bot] history 达阈值，后台触发 distill");
      runDistill().then((r) => {
        if (r) console.log(`[bot] distill 完成: 压缩 ${r.compressed} 条 → 新增 ${r.new_memory} 条 memory`);
      }).catch((e) => console.error("[bot] distill 失败:", e.message));
    }
  } catch (e) {
    stopWaitingTyping();
    stopStallNotice();
    saveHistory(history);
    console.error("[bot] reply 失败:", e.message);
    try {
      await ctx.reply(friendlyErrorReply(e, BOT_DISPLAY_NAME));
    } catch (_) {}
  }
}

// 所有 text 消息：reactive 对话
bot.on("message:text", async (ctx) => {
  // 仅响应 Alice（fail-closed：ALICE_CHAT_ID 未配置时一律拒绝）
  if (!ALICE_CHAT_ID || String(ctx.chat.id) !== String(ALICE_CHAT_ID)) {
    console.log(`[bot] 忽略非 Alice 的消息 chat_id=${ctx.chat.id}`);
    return;
  }

  const pendingImages = consumePendingImages(ctx.chat.id);
  const userMsg = pendingImages.length > 0
    ? `${ctx.message.text}\n\n[上条图片文件: ${pendingImages.join("\n")}]`
    : ctx.message.text;
  await handleMessage(ctx, userMsg, { images: pendingImages });
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
  console.log(`INSTANCE=${INSTANCE_ID}`);
  console.log(`DISPLAY=${BOT_DISPLAY_NAME}`);
  console.log(`DRY_RUN=${DRY_RUN}`);
  console.log(`PROACTIVE_ENABLED=${PROACTIVE_ENABLED}`);
  console.log(`RUN_ON_START=${RUN_ON_START}`);
  console.log(`ALICE_CHAT_ID=${ALICE_CHAT_ID || "(未配置)"}`);

  // 启动 self-loop（如果开启 + 已配置 chat ID）
  if (PROACTIVE_ENABLED && ALICE_CHAT_ID) {
    startSelfLoop({
      sendMessage: async (text) => {
        // proactive 主动 push 同样走多段发送，保持真人节奏
        await sendAsMulti({ bot, chatId: ALICE_CHAT_ID, text });
      },
      dryRun: DRY_RUN,
      runOnStart: RUN_ON_START,
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
