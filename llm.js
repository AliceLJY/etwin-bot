// llm.js — 通过 ssh mini claude -p 调用 mini 端 CC
// 单次推理，stdin 喂 prompt，stdout 拿结果

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const PROJECT_DIR = import.meta.dir;

const SSH_HOST = process.env.MINI_SSH_HOST || "mini";
const CLAUDE_BIN = process.env.MINI_CLAUDE_BIN || "/Users/anxianjingya/.local/bin/claude";
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || "120000", 10);
// transport mode: local-cc | mini-cc
const LLM_MODE = process.env.ETWIN_LLM_MODE || "local-cc";
// model: claude-sonnet-4-6 默认（cost 友好），可改 claude-opus-4-7 / claude-haiku-4-5
const LLM_MODEL = process.env.ETWIN_LLM_MODEL || "claude-sonnet-4-6";

// 读 persona 三件套拼成完整 system prompt
export function buildSystemPrompt() {
  const base = readFileSync(join(PROJECT_DIR, "persona/digital-clone-base.md"), "utf-8");
  const profile = readFileSync(join(PROJECT_DIR, "persona/digital-clone-profile.md"), "utf-8");
  const tuning = readFileSync(join(PROJECT_DIR, "persona/e-tuning.md"), "utf-8");
  return `${base}\n\n---\n\n${profile}\n\n---\n\n${tuning}`;
}

// 用 mini 上的 CC 跑一次单 turn 推理
// promptText 是拼好的完整用户消息（含 system prompt 注入由 -p 自身处理）
// 但 -p 没有 system flag——把 system 拼进 prompt 顶部即可
export async function callMiniCC(userPrompt, opts = {}) {
  const dryRun = opts.dryRun || process.env.ETWIN_DRY_RUN === "true";
  const includeSystem = opts.includeSystem !== false;

  let fullPrompt = userPrompt;
  if (includeSystem) {
    fullPrompt = `${buildSystemPrompt()}\n\n---\n\n# 当前请求\n\n${userPrompt}`;
  }

  if (dryRun) {
    console.log("[llm dry-run] prompt 长度:", fullPrompt.length);
    console.log("[llm dry-run] prompt 前 300 字:", fullPrompt.slice(0, 300));
    return JSON.stringify({
      action: "silent",
      message: "",
      reasoning: "[dry-run mock] llm.js dry-run 模式，未真调 LLM",
      next_check_hint: "4_hours",
    });
  }

  return new Promise((resolve, reject) => {
    let proc;
    const claudeArgs = ["-p", "--output-format=json", "--model", LLM_MODEL];
    if (LLM_MODE === "mini-cc") {
      proc = spawn("ssh", [SSH_HOST, CLAUDE_BIN, ...claudeArgs], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else if (LLM_MODE === "local-cc") {
      proc = spawn(CLAUDE_BIN, claudeArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      reject(new Error(`Unknown ETWIN_LLM_MODE=${LLM_MODE} (expected 'local-cc' or 'mini-cc')`));
      return;
    }

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch (_) {}
      reject(new Error(`LLM call timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`mini CC exit ${code}\nstderr: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // CC -p JSON 输出结构：{ type: "result", result: "...", session_id: "...", ... }
        resolve(parsed.result || stdout.trim());
      } catch (_e) {
        // fallback 当作 plain text
        resolve(stdout.trim());
      }
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

// 解析 LLM 返回的 JSON（self-decision prompt 的输出）
// 容错：LLM 偶尔会用 ```json ... ``` 包裹
export function parseDecisionJSON(text) {
  let cleaned = text.trim();
  // 剥 markdown code fence
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  // 找第一个 { 到最后一个 }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in LLM output: ${text.slice(0, 200)}`);
  }
  const jsonStr = cleaned.slice(start, end + 1);
  return JSON.parse(jsonStr);
}
