#!/usr/bin/env bash
# etwin-bot 启动脚本（dev 模式）
# 生产用 launchd plist

set -e

cd "$(dirname "$0")"

# 加载 env（默认 .env，可用 ETWIN_ENV_FILE=.env.codex 启动第二实例）
ENV_FILE="${ETWIN_ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "❌ 缺 $ENV_FILE，复制 .env.example 改名后填值"
  exit 1
fi

# 依赖
if [ ! -d node_modules ]; then
  echo "📦 安装依赖..."
  bun install
fi

# 启动
echo "🚀 etwin-bot 启动 (ENV_FILE=$ENV_FILE, INSTANCE=$ETWIN_INSTANCE, BACKEND=$ETWIN_LLM_BACKEND, DRY_RUN=$ETWIN_DRY_RUN, PROACTIVE=$ETWIN_PROACTIVE)"
exec bun run bot.js
