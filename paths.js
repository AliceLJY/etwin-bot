// paths.js — runtime paths shared by all etwin-bot modules

import { mkdirSync } from "fs";
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
