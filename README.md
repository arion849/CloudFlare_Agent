# Cloudflare AI Chat

A web chat assistant on Cloudflare Pages + Workers that uses **Workers AI** (Llama 3.1 8B) for responses and **Durable Objects (SQLite)** for per-session memory, with a dedicated summarization workflow step. **$0 spend**: free tiers only.

## What it is

- **Frontend**: Minimal chat UI (vanilla JS) on Cloudflare Pages. Session ID in `localStorage`; buttons: Send, Summarize, Export, New Chat.
- **Backend**: Cloudflare Worker exposing REST API; orchestrates Durable Object + Workers AI. Input validation (message length cap 2,000 chars) and per-session rate limiting (10 req/min).
- **Memory**: One Durable Object per `sessionId`; SQLite tables `messages` and `meta`; methods: init, appendMessage, getRecentMessages, setSummary, getSummary, exportSession.
- **Workflow**: Distinct `POST /api/summarize` endpoint that summarizes the conversation and stores the summary in the DO.

## Architecture

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    Cloudflare Pages                       │
                    │  (static: index.html + app.js, sessionId in localStorage)│
                    └───────────────────────────┬───────────────────────────────┘
                                                │ fetch
                                                ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │                  Cloudflare Worker                        │
                    │  • POST /api/chat   • POST /api/summarize   • GET /api/export │
                    │  • Validation & rate limit                                 │
                    │  • Orchestrates DO + Workers AI                            │
                    └───────────┬─────────────────────────┬─────────────────────┘
                                │                         │
                ┌───────────────▼───────────────┐   ┌─────▼─────┐
                │  Durable Object (per session)  │   │ Workers AI│
                │  ChatSessionDO                 │   │ Llama 3.1 │
                │  SQLite: messages, meta        │   │ 8B        │
                │  appendMessage, getSummary,    │   └───────────┘
                │  setSummary, exportSession     │
                └───────────────────────────────┘
```

**Data flow**

1. **Chat**: UI → `POST /api/chat` → Worker appends user message to DO → Worker loads summary + last N messages from DO → Worker calls Workers AI → Worker appends assistant message to DO → Worker returns reply to UI.
2. **Summarize**: UI → `POST /api/summarize` → Worker loads last M messages from DO → Worker calls Workers AI with summarization prompt → Worker stores summary in DO → Worker returns summary to UI.
3. **Export**: UI → `GET /api/export?sessionId=...` → Worker returns DO export JSON (sessionId, createdAt, updatedAt, summary, messages).

## API Endpoints

| Method | Path | Request / Query | Response |
|--------|------|------------------|----------|
| POST   | `/api/chat`      | Body: `{ sessionId, message }` | `{ ok: true, data: { reply } }` |
| POST   | `/api/summarize` | Body: `{ sessionId }`          | `{ ok: true, data: { summary } }` |
| GET    | `/api/export`    | Query: `sessionId=...`         | `{ ok: true, data: { sessionId, createdAt, updatedAt, summary, messages[] } }` |

- **Errors**: `{ ok: false, error: { code, message } }` with appropriate HTTP status (400, 429, 500, 502).
- **Validation**: `sessionId` required, min length 8; `message` required, trimmed, length 1–2000. Per-session rate limit: 10 requests per minute.

## Local development

### Prerequisites

- Node.js 18+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler` or use `npx`)

### 1. Run the Worker (API + DO + AI)

```bash
cd worker
npm install
npx wrangler dev
```

Worker runs at `http://localhost:8787` by default. SQLite-backed Durable Objects work in local dev.

### 2. Run the frontend (Pages or static server)

**Option A – Static server (same machine, CORS already allowed)**

```bash
cd web/public
npx serve -l 3000
```

Then open `http://localhost:3000`. The UI calls `/api/...` by full URL: set the API base before loading the app. In the browser console (or by editing `index.html`), set:

```js
window.API_BASE = 'http://localhost:8787';
```

Then reload. Or serve `index.html` with a small change: add a script tag that sets `window.API_BASE = 'http://localhost:8787';` for local dev.

**Option B – Inject API base in HTML**

Add to `web/public/index.html` before `app.js`:

```html
<script>window.API_BASE = 'http://localhost:8787';</script>
```

Then open the file via `file://` or any static server; requests go to the local Worker.

**Option C – Pages dev (if you use Wrangler for Pages)**

```bash
cd web/public
npx wrangler pages dev . --port 3000
```

Set `API_BASE` to `http://localhost:8787` as above so the frontend hits the Worker.

### 3. Optional: proxy so same origin

To avoid CORS and keep `API_BASE` empty, put the Worker in front and serve static assets from the Worker (e.g. fetch from another origin or use a single Worker that routes `/api/*` to the API and `/*` to a static asset server). For the smallest setup, using `API_BASE` and CORS (already enabled on the Worker) is enough.

## Deployment

1. **Deploy the Worker**

   ```bash
   cd worker
   npx wrangler deploy
   ```

   Note the Worker URL (e.g. `https://cloudflare-ai-chat.<your-subdomain>.workers.dev`).

2. **Deploy the frontend (Pages)**

   - In Cloudflare Dashboard: **Pages** → **Create project** → **Upload assets**.
   - Upload the contents of `web/public` (or connect a Git repo with `web/public` as the build output / root).
   - Set an environment variable (e.g. `API_BASE`) to the Worker URL above if the frontend is on a different origin.
   - In `index.html`, you can set `window.API_BASE` from a placeholder or leave it empty if you later route both through the same host.

   **Or with Wrangler:**

   ```bash
   cd web/public
   npx wrangler pages project create cloudflare-ai-chat-web  # once
   npx wrangler pages deploy . --project-name=cloudflare-ai-chat-web
   ```

   Then set the Pages env var `API_BASE` (or equivalent) to your Worker URL and, if your build supports it, inject it into `window.API_BASE` in `index.html`.

3. **Free tier**

   - Workers AI: use the free daily Neurons allocation (Llama 3.1 8B is used to stay within free usage).
   - Durable Objects: SQLite-backed; free tier applies.
   - Pages: free tier for static assets.

## Repo structure

```
/worker
  wrangler.toml          # DO binding (CHAT_SESSION), AI binding, vars
  src/
    index.ts             # Worker: routes, validation, rate limit, DO + AI calls
    chatSessionDO.ts     # ChatSessionDO: SQLite messages + meta, all DO methods
  package.json
  tsconfig.json
/web
  public/
    index.html           # Chat UI
    app.js               # Vanilla JS: sessionId, Send / Summarize / Export / New Chat
  package.json
README.md
```

## Choices and limits

- **Model**: `@cf/meta/llama-3.1-8b-instruct-fp8` (free-tier friendly). This implementation uses the available free-tier Llama 3.1 8B.
- **Rate limiting**: In-memory map of request timestamps per `sessionId`; 10 requests per 60 seconds per session. Resets when the Worker instance is recycled.
- **Message cap**: 2,000 characters (configurable via `MESSAGE_MAX_LENGTH` in `wrangler.toml`).
- **History**: Last 10 messages for chat context; last 50 for summarization (configurable via env vars).

## License

Optional; not included by default.
