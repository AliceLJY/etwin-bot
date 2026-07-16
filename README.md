# etwin-bot

**A single-user, proactive Telegram companion with model-led timing.**

**English** | [中文](README_CN.md)

etwin-bot wakes on a configurable timer, gives recent conversation and interaction context to a Claude or Codex backend, and lets the model decide whether to reach out or stay quiet. Cadence is mostly model-led, but not absolute: an explicit `/quiet` command is enforced in code for 24 hours before any LLM call.

## Design Principles

- **Model-led cadence.** The bot wakes periodically; the model reads current context, prompt policy, and interaction history before choosing `ping` or `silent`.
- **Deterministic owner override.** `/quiet` blocks proactive ticks for 24 hours without spending a provider call. Other cadence guidance stays in the selected prompt/persona.
- **Personal persona.** The public repo ships neutral templates; private profile details can live in gitignored `.local.md` overrides.
- **Swappable backend.** The default instance runs on the Claude Agent SDK; a second instance runs on `codex exec`, reusing a Codex subscription instead of an API key.
- **Single-user Telegram boundary.** Non-dry-run startup requires an exact `ALICE_CHAT_ID`, and every tool-bearing text/media handler checks it. Use a dedicated bot token and chat.

## Architecture

```
                  ┌──────────────┐
   You on TG ────►│  bot.js      │ grammy reactive conversation
                  │  (grammy)    │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ self-loop.js │ wakes on a configured interval
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

The tracked env examples use a four-hour interval (`14400000` ms). If the variable is omitted, the code fallback is 30 minutes.

## File Structure

```
etwin-bot/
├── bot.js                    main entry: grammy + self-loop
├── paths.js                  per-instance runtime paths (data / files separation)
├── runtime-files.js          contained, collision-resistant inbound/output paths
├── self-loop.js              proactive driver: wake → LLM decides → act
├── context.js                collects state to feed the LLM
├── llm.js                    backend call (Claude SDK / codex exec)
├── persona/
│   ├── digital-clone-base.md     public neutral persona base
│   ├── digital-clone-profile.md  public neutral operator profile
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

> **Persona files.** The two tracked digital-clone files are regular, neutral templates, so the default mode works in a clean clone. A richer corpus can be maintained separately in [digital-clone-skill](https://github.com/AliceLJY/digital-clone-skill). Next to any `foo.md`, you can add a gitignored `foo.local.md`; the runtime loads it first, keeping private tuning out of the public repo.

## Quick Start

```bash
# 1. Copy the env template and fill in real values
cp .env.example .env
# edit .env, set TG_BOT_TOKEN (from @BotFather)

# 2. Install dependencies
bun install

# 3. Dry-run once (no provider call or proactive send)
ETWIN_DRY_RUN=true bun run bot.js
# dry-run still connects to Telegram, replies to /start/text, and can update local action state
# send the bot /start and read its reply to get your chat ID
# put it in .env as ALICE_CHAT_ID

# 4. Fire one provider-backed self-tick to test the configured LLM path
bun run tick
# this command makes a real backend call unless ETWIN_DRY_RUN=true

# 5. Go live
# edit .env, set ETWIN_DRY_RUN=false
bash start.sh
```

## Security Boundary

This project intentionally gives a personal bot meaningful host access, so the trust boundary matters more than the bot UI:

- `ALICE_CHAT_ID` is mandatory outside dry-run, and media/text handlers repeat the same exact-chat check.
- Claude full mode uses `bypassPermissions`; Codex full mode can be configured as `danger-full-access`. The bot can therefore act with the permissions of the host account.
- Telegram files are downloaded locally, then relevant prompts/files are sent to the selected Claude or Codex path. This is not an offline-only data flow.
- Inbound names are sanitized and resolved under `ETWIN_FILE_DIR`; generated image outputs use contained, collision-resistant names.
- Keep the bot token, chat ID, runtime data, and private `.local.md` files out of the repository. Do not reuse this configuration as a public or multi-user bot.

## Cadence Policy

The selected self-decision prompt and persona carry the ordinary timing policy. The current E-tuning/Codex guidance treats 02:00–06:00 as a sleep window, backs off after recent conversation or repeated unread pings, and rejects empty check-ins. These are model instructions and can vary by prompt; only an active `/quiet` request is a deterministic code gate.

## When the Bot Drifts

1. Read `data/action-log.json` — every decision carries its reasoning, so you can see how it was thinking.
2. Edit `persona/e-tuning.md` to adjust the tendencies, then restart.
3. Send `/quiet` to pause proactive messages — the runtime records a 24-hour quiet window and skips the LLM while it is active.
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
- No multi-user or hosted-service mode. Explicit work requests may enter the local full-tool path; that path is intentionally personal and high privilege.
