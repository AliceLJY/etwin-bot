// distill.js — 无感记忆压缩
// 当 conversation-history 累积到阈值，自动把旧对话 distill 成 long-term memory
// 旧 history 归档，reactive session 重置，新 session 通过 system prompt 注入 memory

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { callMiniCC, parseDecisionJSON } from "./llm.js";
import { PROJECT_DIR, dataPath, ensureRuntimeDirs } from "./paths.js";

ensureRuntimeDirs();

const CONV_HISTORY = dataPath("conversation-history.json");
const LONG_TERM_MEM = dataPath("long-term-memory.json");
const ARCHIVE_DIR = dataPath("archive");
const SESSION_STORE = dataPath("session-ids.json");
const DISTILL_PROMPT_PATH = join(PROJECT_DIR, "prompts/distill.md");
const DISTILL_LOCK = dataPath("distill.lock");

// 当 conversation-history.length 达到此阈值，触发 distill
const TRIGGER_THRESHOLD = parseInt(process.env.ETWIN_DISTILL_THRESHOLD || "60", 10);
// distill 后保留最近多少条（最近上下文不压缩）
const KEEP_RECENT = parseInt(process.env.ETWIN_DISTILL_KEEP_RECENT || "20", 10);

export function loadConversationHistory() {
  if (!existsSync(CONV_HISTORY)) return [];
  try { return JSON.parse(readFileSync(CONV_HISTORY, "utf-8")); } catch (_) { return []; }
}

export function loadLongTermMemory() {
  if (!existsSync(LONG_TERM_MEM)) return [];
  try { return JSON.parse(readFileSync(LONG_TERM_MEM, "utf-8")); } catch (_) { return []; }
}

export function shouldDistill() {
  const history = loadConversationHistory();
  return history.length >= TRIGGER_THRESHOLD;
}

// 加锁防并发——同时有两次 handleMessage 触发，避免两个 distill 一起跑撞车
function acquireLock() {
  if (existsSync(DISTILL_LOCK)) {
    try {
      const stat = readFileSync(DISTILL_LOCK, "utf-8");
      const lockTime = parseInt(stat, 10);
      // 锁超过 10 分钟视为僵死，强制清掉
      if (Date.now() - lockTime > 10 * 60 * 1000) {
        console.warn("[distill] 检测到僵死锁，强制清除");
      } else {
        return false;
      }
    } catch (_) {}
  }
  writeFileSync(DISTILL_LOCK, String(Date.now()));
  return true;
}

function releaseLock() {
  if (existsSync(DISTILL_LOCK)) {
    try {
      renameSync(DISTILL_LOCK, join(homedir(), ".Trash", `etwin-distill-lock-${Date.now()}`));
    } catch (_) {}
  }
}

export async function runDistill() {
  if (!acquireLock()) {
    console.log("[distill] 已有 distill 在跑，本次跳过");
    return null;
  }

  try {
    const history = loadConversationHistory();
    if (history.length < TRIGGER_THRESHOLD) {
      console.log(`[distill] history 长度 ${history.length} 未达阈值 ${TRIGGER_THRESHOLD}，跳过`);
      return null;
    }

    const toCompress = history.slice(0, -KEEP_RECENT);
    const recent = history.slice(-KEEP_RECENT);
    const existingMemory = loadLongTermMemory();

    console.log(`[distill] 开始：压缩 ${toCompress.length} 条 → 保留最近 ${recent.length} 条 + 已有 ${existingMemory.length} 条 memory`);

    const template = readFileSync(DISTILL_PROMPT_PATH, "utf-8");
    const userPrompt = template
      .replace("{{conversation_to_compress}}", JSON.stringify(toCompress, null, 2))
      .replace("{{existing_memory}}", JSON.stringify(existingMemory, null, 2));

    // kind="distill" + fresh=true 走完全独立 session，不污染 reactive/self-loop
    const rawOutput = await callMiniCC(userPrompt, { kind: "distill", fresh: true });

    let newEntries;
    try {
      newEntries = parseDecisionJSON(rawOutput);
    } catch (_e) {
      // distill prompt 输出的是数组不是对象，parseDecisionJSON 找 { 会失败
      // 改用 [ ... ] 匹配
      const cleaned = rawOutput.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");
      if (start === -1 || end === -1) {
        console.error("[distill] 解析失败，原始输出前 500 字:", rawOutput.slice(0, 500));
        return null;
      }
      newEntries = JSON.parse(cleaned.slice(start, end + 1));
    }

    if (!Array.isArray(newEntries)) {
      console.error("[distill] 输出不是数组，type=", typeof newEntries);
      return null;
    }

    // 归档旧 history
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(ARCHIVE_DIR, `conversation-${stamp}.json`);
    writeFileSync(archivePath, JSON.stringify(toCompress, null, 2));
    console.log(`[distill] 归档 → ${archivePath}`);

    // 截短 conversation-history：写回前重读，保留 toCompress 截止时间之后的全部条目。
    // 不能用长度差判断新增——saveHistory 有 slice(-60) 上限，窗口期 append 后长度可能不变
    // （codex 复核抓出）。time 游标对 cap 截断免疫：cutoff 之后的 = 原 recent + 窗口期新增。
    const cutoffTime = toCompress.length > 0 ? toCompress[toCompress.length - 1].time : null;
    const current = loadConversationHistory();
    const keep = cutoffTime
      ? current.filter((m) => !m.time || m.time > cutoffTime)
      : current;
    writeFileSync(CONV_HISTORY, JSON.stringify(keep, null, 2));
    const appendedCount = Math.max(0, keep.length - recent.length);
    console.log(`[distill] conversation-history 截短到 ${keep.length} 条${appendedCount ? `（含 distill 期间新增约 ${appendedCount} 条）` : ""}`);

    // append 新 memory
    const now = new Date().toISOString();
    const stamped = newEntries.map((m) => ({ ...m, distilled_at: now }));
    const allMemory = [...existingMemory, ...stamped];
    writeFileSync(LONG_TERM_MEM, JSON.stringify(allMemory, null, 2));
    console.log(`[distill] 新增 ${stamped.length} 条 memory，总数 ${allMemory.length}`);

    // 重置 reactive session（旧 session 已 stale）
    let sessions = {};
    if (existsSync(SESSION_STORE)) {
      try { sessions = JSON.parse(readFileSync(SESSION_STORE, "utf-8")); } catch (_) {}
    }
    delete sessions.reactive;
    delete sessions.reactive_updated;
    writeFileSync(SESSION_STORE, JSON.stringify(sessions, null, 2));
    console.log("[distill] reactive session 已重置（下次 fresh + memory inject）");

    return {
      compressed: toCompress.length,
      kept_recent: recent.length,
      new_memory: stamped.length,
      total_memory: allMemory.length,
      archive_path: archivePath,
    };
  } catch (err) {
    console.error("[distill] 异常:", err.message);
    return null;
  } finally {
    releaseLock();
  }
}
