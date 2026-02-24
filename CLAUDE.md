# CLAUDE.md — Starbot API

This is the backend for Starbot, an AI assistant system. It's a Fastify/TypeScript server that handles auth, chat persistence, memory injection, LLM streaming, and tool execution.

Live at `https://starbot.cloud/v1/` (proxied through nginx). Runs on port 3737.

---

## Commands

```bash
npm install              # Install deps
npm run dev              # Watch mode (tsx) — recommended for dev
npm run build            # Compile to dist/
npm start                # Run compiled dist/index.js
npm test                 # Vitest (single run)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Coverage report
npm run lint             # ESLint
npm run db:push          # Push schema changes to SQLite
npm run db:migrate       # Create + apply migration (interactive)
npm run db:studio        # Prisma Studio UI
```

## Deploy

```bash
./deploy.sh              # Build, push schema, install service, restart
```

The deploy script installs `deploy/starbot-api.service` to systemd and restarts. Logs: `sudo journalctl -u starbot-api -f`

---

## Environment

Copy `.env.example` to `.env`. Key vars:

- `DATABASE_URL=file:./dev.db` — SQLite, relative to `prisma/` dir (so the file is `prisma/dev.db`)
- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_MODELS`, `AZURE_ALLOWED_DEPLOYMENTS` — Azure OpenAI
- `DEEPSEEK_API_KEY` — DeepSeek (R1 reasoning + V3 chat)
- `BRAVE_SEARCH_API_KEY` — web search tool
- `TOOLS_ENABLED=true` — enables tool execution (web search, calculator, code exec, file ops)

Legacy providers (Kimi, Vertex, Bedrock, Cloudflare) are in the codebase but disabled.

---

## Architecture

### Data Model

- **Project** — top-level container. Has PMEMORY.md (project-wide memory).
- **Workspace** — repo/folder/cloud resource within a project. Has MEMORY.md.
- **Chat** — conversation scoped to a project or workspace.
- **Message** — single message in a chat (`role`: "user" | "assistant").
- **MemoryDocument** — raw PMEMORY.md or MEMORY.md content.
- **MemoryChunk** — semantic chunks with embeddings for retrieval.

Schema is in `prisma/schema.prisma`. Database is SQLite at `prisma/dev.db`.

### Streaming Protocol

All generation goes through `POST /v1/chats/:chatId/run`. Response is SSE streamed via raw fetch (NOT EventSource):

- `message.start` / `message.delta` / `message.stop` — content
- `tool.call` / `tool.result` — tool execution
- `inference.complete` — done

### Memory Injection

1. Client calls `/v1/chats/:chatId/run`
2. API checks scope (workspace thread vs project thread)
3. `services/retrieval.ts` fetches relevant memory chunks via cosine similarity
4. Chunks injected into system prompt before LLM call
5. Workspace threads auto-inject workspace MEMORY.md; project threads auto-inject PMEMORY.md and can retrieve workspace memories via semantic search

### Tool Orchestration

When `TOOLS_ENABLED=true`, the orchestrator (`services/orchestrator/`) handles multi-turn tool calling:
- Parser extracts tool calls from model output
- Executor runs tools and returns results
- Orchestrator loops until the model stops calling tools

DeepSeek models need custom orchestration since they don't support native tool calling.

---

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/projects` | List projects |
| POST | `/v1/projects` | Create project |
| GET/PUT | `/v1/projects/:id` | Get/update project |
| GET | `/v1/projects/:pid/chats` | List chats |
| POST | `/v1/projects/:pid/chats` | Create chat |
| GET/PUT | `/v1/chats/:id` | Get/update chat |
| GET | `/v1/chats/:id/messages` | List messages |
| POST | `/v1/chats/:id/messages` | Add message |
| POST | `/v1/chats/:id/run` | Stream generation (main endpoint) |
| GET/POST | `/v1/projects/:pid/workspaces` | List/create workspaces |
| GET/PUT | `/v1/projects/:pid/pmemory` | Project memory |
| GET/PUT | `/v1/projects/:pid/workspaces/:wid/memory` | Workspace memory |
| GET | `/v1/models` | List available models |
| GET | `/v1/health` | Health check |

Auth: `Authorization: Bearer <token>` on protected routes. Device auth flow in `routes/auth.ts`.

---

## Code Layout

```
src/
  index.ts                  — Server entry, route registration, CORS
  env.ts                    — Environment variable validation
  db.ts                     — Prisma client instance

  routes/
    generation.ts           — POST /v1/chats/:id/run (core streaming endpoint)
    projects.ts             — Project CRUD
    chats.ts                — Chat CRUD
    messages.ts             — Message CRUD
    workspaces.ts           — Workspace CRUD
    memory.ts               — Memory document GET/PUT
    models.ts               — GET /v1/models
    auth.ts                 — Auth flows
    inference.ts            — Legacy inference endpoints (WebGUI compat)
    folders.ts              — Folder operations
    tasks.ts                — Task management
    __tests__/              — Route tests (Vitest)

  providers/
    azure-openai.ts         — Azure OpenAI (primary)
    deepseek.ts             — DeepSeek R1/V3 (custom tool orchestration)
    types.ts                — Provider interface
    bedrock.ts, vertex.ts, cloudflare.ts, kimi.ts — Legacy (disabled)
    index.ts                — Provider registry

  services/
    retrieval.ts            — Semantic search, memory injection
    chunking.ts             — Split markdown into ~800-token chunks
    embeddings.ts           — OpenAI text-embedding-3-large
    model-catalog.ts        — Model definitions and capabilities
    web-search.ts           — Brave Search integration
    filesystem-router.ts    — Local file system navigation
    interpreter.ts          — Code execution
    message-preprocessor.ts — Pre-processing before LLM call
    codex-router.ts         — Codex header routing

    orchestrator/           — Tool calling loop
      orchestrator.ts       — Main loop
      parser.ts             — Extract tool calls from output
      executor.ts           — Run tools
      types.ts

    tools/                  — Tool implementations
      registry.ts           — Tool registry
      web-search-tool.ts
      calculator-tool.ts
      code-exec-tool.ts
      file-read-tool.ts
      shell-exec-tool.ts
      fs-glob-tool.ts, fs-grep-tool.ts, fs-edit-file-tool.ts, etc.
      __tests__/

    triage/                 — Request triage/routing
    task-manager/           — Task management service

  security/
    route-guards.ts         — Auth checks and request guards

prisma/
  schema.prisma             — Database schema
  dev.db                    — SQLite database (gitignored)

deploy/
  starbot-api.service       — Systemd unit file
```

---

## Common Tasks

**Add a new route:** Create handler in `routes/`, use Zod for validation, register in `index.ts`, add tests in `__tests__/`.

**Add a new provider:** Implement the interface in `providers/` (needs `streamChat()`), add env vars to `env.ts`, update `model-catalog.ts` and `/v1/models`.

**Change the schema:** Edit `prisma/schema.prisma`, then `npm run db:push` (dev) or `npm run db:migrate` (production).

**Debug streaming:** Check `npm run dev` console output. The generation route logs provider calls and errors.

---

## Sibling Repos

- **WebGUI** — `/var/www/sites/stella/starbot.cloud` (GitHub: `starbot-web`)
- **TUI** — Rust CLI client in the original monorepo at `/home/stella/projects/starbot/Starbot_TUI`
- **Monorepo** (reference) — `/home/stella/projects/starbot`
