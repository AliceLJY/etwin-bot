# etwin-bot

**A digital-twin Telegram bot that decides for itself when to speak.**

**English** | [中文](README_CN.md)

etwin-bot is a proactive Telegram companion whose sense of timing is handed entirely to the LLM. There are no hardcoded frequency caps, quiet hours, or daily limits. The bot wakes on a timer, reads its own action log and recent interaction rate, and decides for itself whether to reach out or stay quiet — then recalibrates from how you respond.

## Design Principles

- **Agency belongs to the LLM.** The bot wakes periodically; the model reads the current context and decides to ping or stay silent. No rules engine sits in between.
- **No hardcoded limits.** No frequency cap, no quiet hours, no daily quota. The model reads its action log plus interaction rate and self-calibrates. Soft guidance lives in the persona layer, never as hard ceilings (see below).
- **One persona.** A more outgoing rendering of its owner — tuned to enjoy starting conversations, not just answering them.
- **Swappable backend.** The default instance runs on the Claude Agent SDK; a second instance runs on `codex exec`, reusing a Codex subscription instead of an API key.
- **Single Telegram channel.** Physically isolated from other bots — give it its own chat.

## Architecture

```
                  ┌──────────────┐
   You on TG ────►│  bot.js      │ grammy reactive conversation
                  │  (grammy)    │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ self-loop.js │ wakes on its own (~every 4h)
                  │  (interval)  │ → LLM decides ping / silent
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ context.js   │ gathers RecallNest checkpoints / CC activity / git activity / action log
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   llm.js     │ Claude SDK / codex exec
                  └──────────────┘
```

## File Structure

```
etwin-bot/
├── bot.js                    main entry: grammy + self-loop
├── paths.js                  per-instance runtime paths (data / files separation)
├── self-loop.js              proactive driver: wake → LLM decides → act
├── context.js                collects state to feed the LLM
├── llm.js                    backend call (Claude SDK / codex exec)
├── persona/
│   ├── digital-clone-base.md     persona base (see note)
│   ├── digital-clone-profile.md  persona profile (see note)
│   └── e-tuning.md               extraversion tuning layer (unique to this bot)
├── prompts/
│   ├── self-decision.md      self-loop decision prompt (emits JSON)
│   └── reply.md              conversation prompt for direct messages (emits natural language)
├── data/
│   ├── action-log.json       the bot's own send history + your reactions, fed back into the next decision
│   └── conversation-history.json  recent conversation (last ~30 turns)
├── package.json
├── start.sh                  dev launch script
├── .env.example
├── .env.codex.example        Codex-backend instance template
└── README.md
```

> **Persona files.** `digital-clone-base.md` and `digital-clone-profile.md` are the persona corpus. In this repo they ship as symlinks into a local skill workspace that has since been removed, so a fresh clone won't find their targets. The corpus is now maintained separately in [digital-clone-skill](https://github.com/AliceLJY/digital-clone-skill) — supply your own files there, or set `ETWIN_PERSONA=cc` / `codex` to skip the default persona. Next to any `foo.md` you can drop a gitignored `foo.local.md`; the runtime loads it first, so private tuning stays local while the repo keeps a neutral template.

## Quick Start

```bash
# 1. Copy the env template and fill in real values
cp .env.example .env
# edit .env, set TG_BOT_TOKEN (from @BotFather)

# 2. Install dependencies
bun install

# 3. Dry-run once (no LLM call, no Telegram send)
ETWIN_DRY_RUN=true bun run bot.js
# send the bot /start, read the reply to get your chat ID
# put it in .env as ALICE_CHAT_ID

# 4. Fire one self-tick to test the LLM path
bun run tick
# check stdout: did the LLM actually wake and emit a JSON decision?

# 5. Go live
# edit .env, set ETWIN_DRY_RUN=false
bash start.sh
```

## Soft Constraints (held by the LLM, not hard limits)

See `persona/e-tuning.md`. These are tendencies the model is asked to honor, not enforced ceilings:

- Almost never messages between midnight and 7am, unless there's a strong signal
- 3+ messages in one day with under 50% interaction → it backs off on its own
- Interaction rate under 30% for two days running → deep-silent for 24h
- No empty "you there?" pings
- Keeps the owner's voice (avoids stock filler phrases)

## When the Bot Drifts

1. Read `data/action-log.json` — every decision carries its reasoning, so you can see how it was thinking.
2. Edit `persona/e-tuning.md` to adjust the tendencies, then restart.
3. Send `/quiet` to pause proactive messages — the model sees `/quiet` in the action log and settles down.
4. **If you just don't like it, set `ETWIN_PROACTIVE=false`** for pure reactive mode: the bot only replies, never initiates.

## Multiple Instances

Two instance types are supported:

- **`com.etwin-bot`** — the original Claude-backed version, uses `.env`, keeps proactive mode.
- **`com.etwin-codex-bot`** — the Codex-backed version, uses `.env.codex`, keeps a light heartbeat; proactive outreach runs through the chat/self-loop, while tools and images enter the full/image path only on explicit request.

The Codex version stores incoming Telegram images in `files-codex/` and passes them to the backend via `codex exec --image <path>`; an image with no caption is held until the next text message.

Key env for the Codex version:

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

Launch a dev instance:

```bash
ETWIN_ENV_FILE=.env.codex bash start.sh
```

The launchd template is at `deploy/com.etwin-codex-bot.plist.template`.

## Deployment

Runs on a Mac mini under launchd for the long haul (two instances: Claude + Codex).

## Non-Goals

- Doesn't touch telegram-ai-bridge — a separate bot, kept isolated.
- Doesn't touch wechat-ai-bridge — the iLink protocol disallows proactive messages, so this line isn't wired there.
- No chat-log decryption. A privacy boundary, and unnecessary: RecallNest plus Claude Code session logs are enough to sense state.
- No screenshots, camera, or video-call surveillance.
- No engineering-implementation duties. When it spots an engineering problem, it hands off to Claude Code or Codex.
