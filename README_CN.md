# etwin-bot

一个只服务单一操作者、会主动开口的 Telegram 数字搭子。日常节奏主要由模型判断；操作者发出 `/quiet` 后，代码会在调用 LLM 前确定性静默 24 小时。

[English](README.md) | **中文**

## 设计原则

- **节奏主要交给模型**：bot 周期性醒来，模型结合 context、prompt policy 和互动历史决定 `ping` / `silent`
- **操作者有确定性静默权**：`/quiet` 直接拦截 24 小时 proactive tick，不消耗 provider call；其余节奏规则留在所选 prompt/persona
- **人格可私有定制**：公开仓提供中性模板，真实私人画像放在 gitignored 的 `.local.md`
- **后端可切换**：默认 CC 实例走 Claude Agent SDK；Codex 实例走 `codex exec`，复用订阅而非 API key
- **TG 单用户边界**：非 dry-run 启动必须配置精确的 `ALICE_CHAT_ID`，所有会进入工具链路的文字/媒体 handler 都会再次校验；应使用独立 bot token 和 chat

## 架构

```
                  ┌──────────────┐
   TG Alice ─────►│  bot.js      │ grammy reactive 对话
                  │  (grammy)    │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ self-loop.js │ 按配置间隔自驱醒来
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

仓库里的两份 env 示例把间隔设为 `14400000` 毫秒（4 小时）；如果完全不配该变量，代码默认值是 30 分钟。

## 文件结构

```
etwin-bot/
├── bot.js                    主入口：grammy + self-loop
├── paths.js                  多实例 runtime 路径（data / files 分离）
├── runtime-files.js          入站与生成文件的目录约束和防碰撞命名
├── self-loop.js              proactive 自驱：周期醒来→LLM 决策→执行
├── context.js                收集状态喂给 LLM
├── llm.js                    Claude Agent SDK / codex exec 后端调用
├── image-generation.js       明确图片请求的路由
├── interaction.js            静默窗口与互动统计
├── message-split.js          Telegram 安全分段
├── deploy/                   不含个人路径的 launchd 模板
├── install-launchd.sh        按本机路径渲染 LaunchAgent
├── persona/
│   ├── digital-clone-base.md     公开中性人格基底
│   ├── digital-clone-profile.md  公开中性操作者画像
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

> **关于 persona 文件**：仓库跟踪的两个 digital-clone 文件现在都是普通的中性模板，干净 clone 可以直接使用。更完整的语料可由 [digital-clone-skill](https://github.com/AliceLJY/digital-clone-skill) 单独维护。persona / prompts 下任意 `foo.md` 旁都可放一个 gitignored 的 `foo.local.md`；运行时优先读取本地版，私人调节不会进入公开仓。

## 上手

```bash
# 1. 复制 env 模板填实际值
cp .env.example .env
# 编辑 .env，填 TG_BOT_TOKEN（@BotFather 申请）

# 2. 装依赖
bun install

# 3. dry-run 跑一次（不调 provider，也不主动发消息）
ETWIN_DRY_RUN=true bun run bot.js
# dry-run 仍会连接 TG、回复 /start/文字，并可能更新本地 action state
# 给 bot 发 /start，看回复拿你的 chat ID
# 填进 .env 的 ALICE_CHAT_ID

# 4. 手动跑一次会真实调用 provider 的 self-tick
bun run tick
# 除非同时设置 ETWIN_DRY_RUN=true，否则这一步会调用所选后端

# 5. 关掉 dry-run 跑正式
# 编辑 .env 设 ETWIN_DRY_RUN=false
bash start.sh
```

## 安全边界

这个项目刻意让个人 bot 拥有较高的宿主机能力，因此真正重要的是信任边界：

- 非 dry-run 必须配置 `ALICE_CHAT_ID`，文字和媒体 handler 都会重复做精确 chat 校验。
- Claude full 模式使用 `bypassPermissions`；Codex full 模式可以配置为 `danger-full-access`。bot 能做什么，取决于运行它的本机账户拥有什么权限。
- TG 文件先下载到本地，再把相关 prompt / 文件交给所选 Claude 或 Codex 链路；它不是完全离线的数据流。
- 入站文件名会先净化并约束在 `ETWIN_FILE_DIR` 内；生成图片也使用目录内、防碰撞的文件名。
- bot token、chat ID、runtime data 和私人 `.local.md` 都不能提交到仓库，也不应把这套配置直接改成公开或多用户 bot。

## 主动节奏策略

普通节奏由当前 self-decision prompt 和 persona 决定。现有 E-tuning / Codex 规则把 02:00–06:00 视为睡眠窗口；刚结束对话、近期刚 ping 或连续未读时会倾向后退，也不允许发空洞的“在吗”。这些是模型指令，具体阈值可随所选 prompt 改变；只有仍在有效期内的 `/quiet` 是代码层硬门。

## 看到 bot 走偏怎么办

1. 看 `data/action-log.json` —— bot 的每条决策都带 reasoning，能看出它怎么想的
2. 改 `persona/e-tuning.md` 调节人格倾向 + 重启 bot
3. 发 `/quiet` 让 bot 暂停：runtime 会记录 24 小时静默期，在有效期内直接跳过 LLM
4. **真的不喜欢就 `ETWIN_PROACTIVE=false` 切纯 reactive 模式**——bot 只回不主动

## 多实例运行

当前支持两种实例：

- `com.etwin-bot`：原 CC 版，使用 `.env`，保留 proactive。
- `com.etwin-codex-bot`：Codex 版，使用 `.env.codex`，保留轻心跳；主动关心走 chat/self-loop，工具和图片只在明确请求时进入 full/image 链路。
- Codex 版收到 TG 图片时会先存入 `files-codex/`，再通过 `codex exec --image <path>` 传给后端；无 caption 的图片会暂存到下一条文字一起处理。

Codex 版关键 env：

```bash
ETWIN_INSTANCE=codex
ETWIN_PERSONA=codex
ETWIN_LLM_BACKEND=codex
ETWIN_REPLY_PROMPT=prompts/reply-codex.md
ETWIN_DATA_DIR=data-codex
ETWIN_FILE_DIR=files-codex
ETWIN_PROACTIVE=true
ETWIN_RUN_ON_START=false
ETWIN_SELF_PROMPT=prompts/self-decision-codex.md
```

启动 dev 实例：

```bash
ETWIN_ENV_FILE=.env.codex bash start.sh
```

launchd 模板见 `deploy/com.etwin-codex-bot.plist.template`。

## 部署位置

部署在 Mac mini 上，用 launchd 长期跑（双实例：Claude + Codex）。
仓库中的模板只保留占位符，不保存用户名或 checkout 绝对路径。先按当前机器渲染两个 LaunchAgent，再加载需要的服务：

```bash
./install-launchd.sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.etwin-bot.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.etwin-bot.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.etwin-codex-bot.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.etwin-codex-bot.plist"
```

Claude SDK 调用受 `ETWIN_CLAUDE_TIMEOUT_MS` 限制，默认 10 分钟，到期会主动 abort。self-loop 不允许重入：上一条主动调用仍未结束时，下一次定时 tick 会跳过，不会再发起第二条模型调用。

## 不做什么

- ❌ 不动 telegram-ai-bridge（独立 bot，不污染那边）
- ❌ 不动 wechat-ai-bridge（iLink 协议不允许主动，不挂这条线）
- ❌ 不挂任何聊天记录解密工具（隐私边界，且不需要——E-Twin 通过 RecallNest + CC jsonl 看 Alice 状态够了）
- ❌ 不做 Sentinel 截图 / 摄像头 / 视频通话
- ❌ 不提供多用户或托管服务模式。明确的工作请求可以进入本机 full-tool 链路；这条链路只适合个人、高信任场景
