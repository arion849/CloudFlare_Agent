# Cloudflare AI Chat

A chat application built on Cloudflare Workers, Durable Objects, Workers AI, and R2. The frontend is a static page (Cloudflare Pages or any static host) that talks to a Worker API. Sessions are persisted in a Durable Object with SQLite; optional file attachments are stored in R2.

## Purpose

This project demonstrates a small but complete stack on Cloudflare: a Worker that coordinates Durable Objects (state), Workers AI (Llama 3.1 8B), and R2 (file storage), with a separate summarization step and a minimal web UI. It is built to run within free-tier limits.

## Architecture

- **Frontend**: Single HTML page with inline CSS and JavaScript. Session ID in `sessionStorage`. No build step.
- **Worker**: Handles `/api/chat`, `/api/summarize`, `/api/export`, `/api/upload`, and `/api/file`. Validates input, applies per-session rate limits, and forwards work to a Durable Object and Workers AI. File uploads go to R2; file content is never stored in the Durable Object.
- **Durable Object (ChatSessionDO)**: One instance per session ID. SQLite tables for messages and meta (including a stored summary). Exposes internal RPC over `fetch` for the Worker to call.
- **R2**: One bucket for uploaded files. Keys are `uploads/{fileId}-{sanitizedFilename}`. Only text files (`.txt`, `.md`, `.json`) up to 1 MB.

## Features

- Send messages and receive replies from Llama 3.1 8B via Workers AI.
- Per-session chat history and optional conversation summary stored in the Durable Object.
- Export session data (summary + messages) as JSON.
- Attach one text file per message (upload to R2); content is injected into the next chat request as context for the model only.
- Rate limiting: 10 requests per 60 seconds per session (in-memory in the Worker).
- CORS enabled for cross-origin frontend.

## Tech stack

- **Runtime**: Cloudflare Workers.
- **State**: Durable Objects with SQLite storage.
- **Model**: Workers AI, `@cf/meta/llama-3.1-8b-instruct-fp8`.
- **Storage**: R2 for file uploads.
- **Frontend**: Vanilla JS, no framework. Session in `sessionStorage`.

## Run locally

**Prerequisites:** Node.js 18+, Wrangler (`npm i -g wrangler` or use `npx`).

1. **Create the R2 bucket** (once):

   ```bash
   cd worker
   npx wrangler r2 bucket create cloudflare-ai-chat-uploads
   ```

2. **Start the Worker:**

   ```bash
   cd worker
   npm install
   npx wrangler dev
   ```

   API at `http://localhost:8787`. If the frontend is opened from another host (e.g. by IP), run `npx wrangler dev --ip 0.0.0.0` so the browser can reach it.

3. **Serve the frontend:**

   ```bash
   cd web/public
   npx serve -l 3000
   ```

   Open `http://localhost:3000`. The page infers the API base from the current host and port 8787. To point at a different API, set `window.API_BASE` before the main script (e.g. `http://localhost:8787`).

## Deploy

1. **Worker:** From `worker`, run `npx wrangler deploy`. Ensure the R2 bucket `cloudflare-ai-chat-uploads` exists (create via dashboard or `wrangler r2 bucket create`).
2. **Frontend:** Upload the contents of `web/public` to Cloudflare Pages (or any static host). If the frontend and Worker are on different origins, set `window.API_BASE` to the Worker URL (e.g. in a build step or a small inline script that reads an env var).

## API summary

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/chat` | Send a message; optional `fileId` to attach uploaded file content as context. Returns `{ ok, data: { reply } }`. |
| POST | `/api/summarize` | Summarize recent messages and store summary in the session. |
| GET | `/api/export` | Query `sessionId=...`; returns session metadata and messages. |
| POST | `/api/upload` | Multipart form, field `file`. Allowed: `.txt`, `.md`, `.json`, max 1 MB. Returns `{ ok, data: { fileId, filename, contentType, size } }`. |
| GET | `/api/file` | Query `fileId=...`; returns file content (capped at 100 KB) as JSON. |

Errors: `{ ok: false, error: { code, message } }` with appropriate status codes. Validation: `sessionId` length ≥ 8; message length 1–2000; rate limit 10 req/60s per session.

## Limits and scope

- **Message length:** 2,000 characters (configurable via `MESSAGE_MAX_LENGTH` in `wrangler.toml`).
- **Chat context:** Last 10 messages; summarization uses last 50 (configurable).
- **Uploads:** Text files only, 1 MB max. Stored in R2; only the current attachment is sent with the next message (no long-term attachment list in the DO).
- **Rate limit:** In-memory; resets when the Worker instance is recycled.
- **No auth:** Session ID is client-chosen; suitable for demos and trusted use.

## Possible improvements

- Add authentication or session binding so session IDs cannot be guessed.
- Persist rate-limit state (e.g. in the Durable Object or a KV namespace) so limits survive Worker restarts.
- Optional: allow multiple attachments per message or a small list of recent file IDs in the session.
