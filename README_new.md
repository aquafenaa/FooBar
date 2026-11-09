# FooBar

A Discord bot written in TypeScript. It began in 2023 as a set of utilities for my own servers and grew into an **LLM agent** with tool use, long-term memory, a Docker sandbox, and support for MCP servers. It runs in a few servers I'm part of.

**Stack:** TypeScript · Node.js · discord.js v14 · SQLite (better-sqlite3) · OpenRouter · Model Context Protocol · Docker · Caddy

---

## Highlights

- **An agent loop with more than 40 tools.** The model can read and search channels, send messages and embeds, manage reminders and counters, search the web, fetch URLs, look at images, use Bluesky, and run shell commands in a sandbox. It can make up to 50 model calls per reply.
- **Memory that stays within a budget.** Conversations are capped at about 10k tokens. When a conversation ends, a smaller model summarizes it. The summary is embedded, and later replies pull in the summaries most similar to the current message (top-k by embedding similarity). Older tool results are shrunk to short "digests" so the prompt doesn't keep growing.
- **Reasoning effort chosen per message.** Before each reply, the bot sends four typed yes/no questions about the message to a fast classifier ([TypeSafe's Jev](https://typesafe.ai)): is it casual, does it take several steps, does it need careful reasoning, would a mistake be costly? The calibrated probabilities set the model's reasoning effort, so small talk is cheap and hard questions get more thought. The request has a 3-second timeout, and if it fails the bot uses the default effort.
- **Sandboxed code execution.** Shell commands run through `docker exec` in a container with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and limits on memory, CPU, and process count. The bot can also host its own website from the sandbox. A Caddy reverse proxy handles HTTPS and blocks dotfiles, scripts, and logs from being served.
- **MCP client.** Server admins can connect remote MCP servers with `/mcp`, and their tools appear next to the built-in ones. Connections are shared between replies, and private, loopback, and link-local addresses are refused so the bot can't be pointed at its own host's services (SSRF protection).
- **Discord-native UX.** Each reply has 🔄 retry and ◀️ ▶️ buttons to switch between versions. While a reply is being written, a status message shows which tools are being used and has **Stop** (answer now) and **Cancel** buttons. Admins choose tool groups with a modal of checkboxes.
- **Opt-in and private by default.** Users must `/subscribe` before the bot reads or replies to them. Sharing context across servers needs both the server and every user in the conversation to opt in. Tools that read channels only see channels everyone in the server can see.

## Features

### AI agent (`/chatbot`, `/subscribe`, `/heartbeat`, `/mcp`)
- Replies when pinged or replied to, with a configurable model, temperature, reasoning effort, persona, and system prompt for each server
- Persistent **memories** the model can create and edit, and searchable **conversation summaries**, both viewable and editable by admins
- **Heartbeats**: prompts on a cron schedule, so the bot can post on its own (for example, a morning check-in)
- **Shared or detached context**: servers can share one "personality" or keep their own
- **Owner DMs**: allowlisted users get full control over the bot through direct messages
- **Image understanding**: models with vision see recent images directly. For other models, images are captioned once and the caption is saved with the message
- Tool groups can be turned on or off per server, which keeps costs under control

### Server utilities
| Command | What it does |
|---|---|
| `/heartboard` | Reposts a message to a "hall of fame" channel once it gets enough of the chosen reactions |
| `/voiceping` | Posts in a text channel when someone joins a chosen voice channel |
| `/response` | Regex-based automatic replies (e.g. rewriting `x.com` links to embed-friendly ones). React 🗑️ to delete the reply |
| `/reminder` | One-time or recurring (cron) reminders |
| `/counter` | Named counters for a server |

## Architecture

```
dev/
├── index.ts          Entry point: Discord client, slash command registration, OpenRouter client
├── events.ts         Discord event handlers (messages, reactions, voice, interactions)
├── commands.ts       Slash command definitions and handlers
├── data.ts           SQLite data layer and scheduled jobs
└── chatbot/
    ├── chatbot.ts      Agent loop: builds context, offers tools, runs tool calls, streams status
    ├── tools.ts        Built-in tool implementations (Discord, memory, web, Bluesky, sandbox, …)
    ├── conversation.ts Conversation lifetime, summarization, tool-result digests
    ├── effort.ts       Per-message reasoning effort through TypeSafe/Jev
    ├── mcp.ts          MCP client: connections, tool discovery, address filtering
    ├── sandbox.ts      Running commands in the Docker sandbox
    ├── replies.ts      Retry and version buttons, Stop and Cancel controls
    ├── vision.ts       Image captioning and caching
    ├── heartbeat.ts    Scheduled prompts
    ├── context.ts      Shared and detached context between servers
    ├── dm.ts           Owner DMs
    └── models.ts       OpenRouter model catalog, cached in memory and refreshed hourly
data/seed/schema.sql  Database schema (27 tables)
sandbox/Dockerfile    The agent's sandbox image
web/Caddyfile         Reverse proxy for the bot's website
```

**How a reply works:**
1. Load the recent conversation and add the replied-to message if it's missing
2. Embed the prompt and fetch the most similar past summaries
3. Load memories, and caption any images
4. Choose the reasoning effort for this message
5. Call the model with the enabled tools, plus each connected MCP server's tools
6. Run the tool calls and loop, updating the status message as it goes
7. Send the reply with its buttons, and save the messages and tool results
8. When the conversation runs past its token budget or expires, summarize it, embed the summary, and clear the messages

## Design decisions

- **The bot fills in tool context, not the model.** Values like the current server and the user's permissions come from the bot, so the model can't get them wrong or reach another server's data.
- **Failures don't stop a reply.** Summaries, embeddings, and effort judgments are optional extras. If one fails, it's logged and the reply goes ahead without it. OpenRouter calls retry with exponential backoff.
- **Every unit of cost has a limit.** Tool steps, conversation tokens, summary attempts, image count, and tool output length all have explicit caps. Tools that cost money per call (for example, X search) are only offered when they're configured, and admins can turn them off.

## Running it yourself

**Requirements:** Node.js 20+, and optionally Docker for the sandbox and website.

```bash
npm install
# create a .env with the variables below, and a system prompt at data/SYSTEM.md
npm start
```

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID` | ✅ | Discord bot credentials |
| `OPEN_ROUTER_KEY` | ✅ for AI | LLM and embedding calls |
| `DISCORD_ID` | | The bot's Discord user ID, put into the system prompt |
| `DM_USERS` | | Comma-separated user IDs allowed to control the bot through DMs |
| `JEV_KEY` | | Turns on per-message reasoning effort |
| `SANDBOX_CONTAINER`, `SITE_URL` | | Sandbox container name and the public website URL (`docker compose up -d`) |
| `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, `BLUESKY_SERVICE` | | Bluesky account for the bot |
| `TWITTER_API_KEY` | | Turns on X search |

> **Note:** The AI features only work in an allowlist of servers (`ALLOWED_SERVERS` in [dev/chatbot/chatbot.ts](dev/chatbot/chatbot.ts)) to keep API costs down. Add your own server's ID there.

## Roadmap

- [ ] Use a character budget for context, not a message count
- [ ] Show ratings, calculated from reactions
- [ ] Show progress tracker (season, episode, timestamp)
- [ ] Localized time tags, timezone conversion, and birthday reminders
- [ ] Music playback in voice channels

---

Found a bug or have an idea? [Open an issue](https://github.com/aquafenaa/FooBar/issues).
