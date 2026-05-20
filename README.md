# etwin-bot

Alice 的 E-Twin —— 数字分身的**外向化镜像**。

## 设计原则

- **Agency 全交给 LLM**：bot 周期性醒来一次，LLM 自己看 context 自己决定 ping / silent
- **没有硬编码的 frequency cap / quiet hours / daily limit**：LLM 看 action log + 互动率自己 calibrate
- **唯一人格定义**：E 化的 Alice，爱和 I 化的 Alice 聊天
- **后端可切换**：默认 CC 实例走 Claude Agent SDK；Codex 实例走 `codex exec`，复用订阅而非 API key
- **TG 单一通道**：和 Hermes bots / telegram-ai-bridge 物理隔离（建议开独立 chat）

## 架构

```
                  ┌──────────────┐
   TG Alice ─────►│  bot.js      │ grammy reactive 对话
                  │  (grammy)    │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ self-loop.js │ 每 30 分钟自驱醒来一次
                  │  (interval)  │ → LLM 决定 ping/silent
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ context.js   │ 收集 RecallNest checkpoint / CC 活动 / git 活动 / action log
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   llm.js     │ Claude SDK / codex exec
                  └──────────────┘
```

## 文件结构

```
etwin-bot/
├── bot.js                    主入口：grammy + self-loop
├── paths.js                  多实例 runtime 路径（data / files 分离）
├── self-loop.js              proactive 自驱：周期醒来→LLM 决策→执行
├── context.js                收集状态喂给 LLM
├── llm.js                    ssh mini claude -p 调用
├── persona/
│   ├── digital-clone-base.md     symlink → ~/.claude/skills/digital-clone/clone-workspace/system-prompt.md
│   ├── digital-clone-profile.md  symlink → 同上 persona.md
│   └── e-tuning.md           E 化调节层（这个 bot 独有的人格调节）
├── prompts/
│   ├── self-decision.md      self-loop 用的判断 prompt（输出 JSON）
│   └── reply.md              Alice ping bot 时用的对话 prompt（输出自然中文）
├── data/
│   ├── action-log.json       bot 自己的发送历史 + Alice 反应（喂回给下次决策）
│   └── conversation-history.json  对话历史（最近 30 轮）
├── package.json
├── start.sh                  dev 启动脚本
├── .env.example
├── .env.codex.example        Codex 后端实例模板
└── README.md
```

## 上手

```bash
# 1. 复制 env 模板填实际值
cp .env.example .env
# 编辑 .env，填 TG_BOT_TOKEN（@BotFather 申请）

# 2. 装依赖
bun install

# 3. dry-run 跑一次（不调 LLM 不发 TG）
ETWIN_DRY_RUN=true bun run bot.js
# 给 bot 发 /start，看 reply 拿你的 chat ID
# 填进 .env 的 ALICE_CHAT_ID

# 4. 手动跑一次 self-tick 测试 LLM 通道
bun run tick
# 看 stdout 是不是 LLM 真的醒来 + 给出 JSON 决策

# 5. 关掉 dry-run 跑正式
# 编辑 .env 设 ETWIN_DRY_RUN=false
bash start.sh
```

## 几个柔性约束（LLM 自己掌握，不是 hard limit）

详见 `persona/e-tuning.md`：

- 半夜 0-7 点几乎不发（除非有强信号）
- 同一天 3+ 条 + 互动率 < 50% → 自己识趣 silent
- 互动率连续 2 天 < 30% → deep-silent 24h
- 不发"你在吗"空 ping
- 保持 Alice 语言洁癖（不用"落盘 / 齐活 / 搞定"等速记词）

## 看到 bot 走偏怎么办

1. 看 `data/action-log.json` —— bot 的每条决策都带 reasoning，能看出它怎么想的
2. 改 `persona/e-tuning.md` 调节人格倾向 + 重启 bot
3. 极端情况发 `/quiet` 命令让 bot 暂停（LLM 看到 action log 里的 /quiet 会自觉冷静）
4. **真的不喜欢就 `ETWIN_PROACTIVE=false` 切纯 reactive 模式**——bot 只回不主动

## 多实例运行

当前支持两种实例：

- `com.etwin-bot`：原 CC 版，使用 `.env`，保留 proactive。
- `com.etwin-codex-bot`：Codex 版，使用 `.env.codex`，第一版 `ETWIN_PROACTIVE=false`，只 reactive。
- Codex 版收到 TG 图片时会先存入 `files-codex/`，再通过 `codex exec --image <path>` 传给后端；无 caption 的图片会暂存到下一条文字一起处理。

Codex 版关键 env：

```bash
ETWIN_INSTANCE=codex
ETWIN_PERSONA=codex
ETWIN_LLM_BACKEND=codex
ETWIN_REPLY_PROMPT=prompts/reply-codex.md
ETWIN_DATA_DIR=data-codex
ETWIN_FILE_DIR=files-codex
ETWIN_PROACTIVE=false
ETWIN_RUN_ON_START=false
```

启动 dev 实例：

```bash
ETWIN_ENV_FILE=.env.codex bash start.sh
```

launchd 模板见 `deploy/com.etwin-codex-bot.plist.template`。

## 部署位置

PoC 阶段已迁到 Mac mini 上用 launchd 长期跑。

## 不做什么

- ❌ 不动 telegram-ai-bridge（独立 bot，不污染那边）
- ❌ 不动 wechat-ai-bridge（iLink 协议不允许主动，不挂这条线）
- ❌ 不挂 wechat-decrypt（隐私边界，且不需要——E-Twin 通过 RecallNest + CC jsonl 看 Alice 状态够了）
- ❌ 不做 Sentinel 截图 / 摄像头 / 视频通话
- ❌ 不偷 trio 的工程实施权（看到工程问题转手给 CC / Codex）
