// paths.js — runtime paths shared by all etwin-bot modules

import { existsSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";

export const PROJECT_DIR = import.meta.dir;
export const INSTANCE_ID = process.env.ETWIN_INSTANCE || "cc";

function projectPath(value, fallback) {
  if (!value) return fallback;
  return isAbsolute(value) ? value : resolve(PROJECT_DIR, value);
}

export const DATA_DIR = projectPath(
  process.env.ETWIN_DATA_DIR,
  join(PROJECT_DIR, "data"),
);

export const FILE_DIR = projectPath(
  process.env.ETWIN_FILE_DIR,
  INSTANCE_ID === "cc" ? join(PROJECT_DIR, "files") : join(PROJECT_DIR, `files-${INSTANCE_ID}`),
);

export function ensureRuntimeDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(FILE_DIR, { recursive: true });
}

export function dataPath(name) {
  return join(DATA_DIR, name);
}

// persona/prompt 模板的本地覆盖机制：foo.md 旁若存在 foo.local.md（gitignore，不入公开仓），
// 优先用本地版——私人化调节内容留在本机，仓库只保留中性模板
export function readPromptFile(absPath) {
  const localPath = absPath.replace(/\.md$/, ".local.md");
  if (existsSync(localPath)) return readFileSync(localPath, "utf-8");
  return readFileSync(absPath, "utf-8");
}
