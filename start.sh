#!/usr/bin/env bash
# etwin-bot 启动脚本（dev 模式）
# 生产用 launchd plist

set -e

cd "$(dirname "$0")"

# 加载 .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
else
  echo "❌ 缺 .env，复制 .env.example 改名为 .env 并填值"
  exit 1
fi

# 依赖
if [ ! -d node_modules ]; then
  echo "📦 安装依赖..."
  bun install
fi

# 启动
echo "🚀 etwin-bot 启动 (DRY_RUN=$ETWIN_DRY_RUN, PROACTIVE=$ETWIN_PROACTIVE)"
exec bun run bot.js
