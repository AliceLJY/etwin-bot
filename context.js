// context.js — 收集当前状态 context 喂给 LLM self-loop

import { readFileSync, statSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { dataPath, ensureRuntimeDirs } from "./paths.js";
import { computeInteractionStats } from "./interaction.js";

ensureRuntimeDirs();

const ACTION_LOG = dataPath("action-log.json");
const CONV_HISTORY = dataPath("conversation-history.json");
const HOME = homedir();
const RECALL_SCOPE = process.env.ETWIN_RECALL_SCOPE || "etwin:alice";

export function quoteRemoteShellArg(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildLatestCheckpointCommand(scope) {
  return [
    'cd "$HOME/recallnest"',
    '&& "$HOME/.bun/bin/bun" run src/cli.ts latest-checkpoint',
    `--scope ${quoteRemoteShellArg(scope)}`,
    "--json 2>/dev/null",
    "|| printf '%s\\n' '{}'",
  ].join(" ");
}

export function buildLatestCheckpointSshArgs(host, scope) {
  return ["--", host, buildLatestCheckpointCommand(scope)];
}

// 读最近 N 轮对话历史（让 self-loop LLM 能看到 Alice 最近说的话，识别 pause signal）
function loadRecentConversation(n = 10) {
  if (!existsSync(CONV_HISTORY)) return [];
  try {
    const all = JSON.parse(readFileSync(CONV_HISTORY, "utf-8"));
    return all.slice(-n);
  } catch (_e) {
    return [];
  }
}

// 读 bot 自己的 action 历史
export function loadActionLog() {
  if (!existsSync(ACTION_LOG)) return [];
  try {
    return JSON.parse(readFileSync(ACTION_LOG, "utf-8"));
  } catch (_e) {
    return [];
  }
}

// 取过去 N 小时的 action
export function recentActions(hours = 48) {
  const log = loadActionLog();
  const cutoff = Date.now() - hours * 3600_000;
  return log.filter((a) => new Date(a.time).getTime() > cutoff);
}

// 算 Alice 互动率（纯逻辑在 interaction.js，这里只负责读 action-log）
export function interactionStats(days = 7) {
  return computeInteractionStats(loadActionLog(), days);
}

// Alice 最后一次和 CC 对话的时间（扫 ~/.claude/projects/-Users-anxianjingya/*.jsonl 最新 mtime）
function lastCCActivity() {
  try {
    const dir = join(HOME, ".claude/projects/-Users-anxianjingya");
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    let latest = 0;
    for (const f of files) {
      try {
        const m = statSync(join(dir, f)).mtimeMs;
        if (m > latest) latest = m;
      } catch (_) {}
    }
    return latest > 0 ? new Date(latest).toISOString() : null;
  } catch (_e) {
    return null;
  }
}

// Alice 最近 git push 时间（扫主力仓库）
function lastGitActivity() {
  const repos = [
    join(HOME, "Projects/telegram-ai-bridge"),
    join(HOME, "Projects/wechat-ai-bridge"),
    join(HOME, "Projects/etwin-bot"),
    join(HOME, "Projects/河马项目/hippo-wiki"),
    join(HOME, "Downloads/sync-bridge"),
  ];
  let latest = 0;
  for (const r of repos) {
    if (!existsSync(join(r, ".git"))) continue;
    try {
      const out = execFileSync("git", ["log", "-1", "--format=%ct"], {
        cwd: r,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const ts = parseInt(out, 10);
      if (ts && ts * 1000 > latest) latest = ts * 1000;
    } catch (_) {}
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

// RecallNest etwin:alice scope 的 latest checkpoint
// 第一版用 ssh mini 调 RecallNest CLI，失败就 fallback 到 null
async function fetchLatestCheckpoint() {
  try {
    const sshHost = process.env.MINI_SSH_HOST || "mini";
    const out = execFileSync(
      "ssh",
      buildLatestCheckpointSshArgs(sshHost, RECALL_SCOPE),
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return JSON.parse(out || "{}");
  } catch (_e) {
    return null;
  }
}

// 收集完整 context
export async function gatherContext() {
  const now = new Date();
  const ccLast = lastCCActivity();
  const gitLast = lastGitActivity();
  const checkpoint = await fetchLatestCheckpoint();

  const hoursSince = (iso) => {
    if (!iso) return null;
    return Math.round((now.getTime() - new Date(iso).getTime()) / 3600_000 * 10) / 10;
  };

  return {
    time_now: now.toISOString(),
    hour_of_day: now.getHours(),
    day_of_week: now.toLocaleDateString("en-US", { weekday: "long" }),
    alice_last_cc_hours_ago: hoursSince(ccLast),
    alice_last_git_hours_ago: hoursSince(gitLast),
    latest_recallnest_checkpoint: checkpoint,
    bot_recent_actions_48h: recentActions(48),
    alice_interaction_stats_7d: interactionStats(7),
    // 让 self-loop LLM 看 Alice 最近说的话，识别 "我去看戏"/"忙"/"晚点聊" 之类 pause signal
    recent_conversation: loadRecentConversation(10),
  };
}
