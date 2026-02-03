# Cloudflare AI App Assignment – Project Specification (Single Source of Truth)
Author: Arion Caushi  
Date: 2026-02-02  
Status: v1.0

## Purpose
This document is the authoritative specification for the Cloudflare AI app assignment project.
All implementation decisions should follow this spec to avoid scope creep and keep the project reviewable.

## Hard constraints
- **$0 spend**: Use only Cloudflare Free tiers and free allocations.
- **Small scope**: Must be buildable fast and easy to review.
- **Credible**: No fake features. Everything in README must work.
- **Security-minded**: Validate inputs, basic rate limiting, no secrets in repo.

## Goal (what must be demonstrated)
The app must include all of the following:
1) **LLM**: Use Workers AI (recommended: Llama 3.3) or an external LLM (but prefer Workers AI to show platform usage).
2) **Workflow / coordination**: Use Workers plus Durable Objects as the coordinator. A distinct “workflow step” endpoint must exist.
3) **User input**: A web chat UI that collects user messages and sends them to the backend.
4) **Memory / state**: Persist conversation history and a running session summary in a Durable Object backed by SQLite.

## One-sentence description
A web chat assistant hosted on Cloudflare Pages + Workers that uses Workers AI for responses and Durable Objects (SQLite) to store per-session memory, plus a dedicated summarization workflow step.

---

# System requirements

## Functional requirements (must-have)
### FR-1 Chat
- The user can open a web page and send a message.
- The system returns an assistant message.
- Messages appear in the UI as a chat transcript.

### FR-2 Sessions
- The UI generates a `sessionId` (UUID or similar) and persists it in `localStorage`.
- Refreshing the page must keep the same session (unless user clicks “New chat”).

### FR-3 Memory storage
- Each user message and assistant message must be stored in a Durable Object scoped to `sessionId`.
- Durable Object storage must use **SQLite** (not in-memory).

### FR-4 Prompt building with memory
- The LLM prompt must include:
  - a short system prompt
  - the stored summary (if present)
  - the last N messages (cap to control cost)
  - the current user message

### FR-5 Workflow step
- A separate endpoint must exist that runs a workflow-like action:
  - `POST /api/summarize` must summarize the session’s conversation and store it in Durable Object state.

### FR-6 Export
- A user can export the conversation as JSON:
  - `GET /api/export?sessionId=...` returns transcript + summary.

### FR-7 Basic guardrails
- Input validation on all endpoints.
- Limit message length (example: 2,000 chars).
- Simple per-session rate limiting (example: 10 requests / minute).
- Never log full conversation content in production logs.

## Non-functional requirements (must-have)
### NFR-1 Free tier friendliness
- Prompt size must be capped.
- History fetch must be limited.
- Summarization should be on-demand, not automatic per message.

### NFR-2 Reliability
- Clear error messages returned to client.
- Handle empty / invalid `sessionId` and messages.

### NFR-3 Reviewability
- Repo must contain a strong README with:
  - architecture overview
  - endpoints
  - local dev steps
  - deploy steps
  - screenshots (optional but recommended)

---

# Architecture

## Components
1) **Cloudflare Pages** (frontend)
- Static site with chat UI.
- Communicates with Worker API via fetch.

2) **Cloudflare Worker** (backend API + coordinator)
- Exposes REST endpoints.
- Orchestrates calls to Durable Object and Workers AI.
- Implements rate limiting and validation.

3) **Durable Object**: `ChatSessionDO`
- One instance per `sessionId`.
- Stores messages and summary in SQLite.
- Enforces ordering and consistency per session.

4) **Workers AI**
- LLM inference endpoint.
- Use a Llama 3.3 model available in Workers AI.

## Data flow
1) UI sends message -> `POST /api/chat`
2) Worker validates -> writes user message to DO
3) Worker loads summary + last N messages from DO
4) Worker calls Workers AI -> receives assistant output
5) Worker writes assistant message to DO
6) Worker returns assistant output to UI

Summarize:
1) UI calls `POST /api/summarize`
2) Worker loads recent transcript from DO
3) Worker calls Workers AI summarization prompt
4) Worker stores summary in DO
5) Worker returns summary to UI

Export:
- UI calls `GET /api/export?sessionId=...`
- Worker returns DO export JSON

---

# API contract (backend)

## Common response shape (recommended)
- Success: `{ ok: true, data: ... }`
- Error: `{ ok: false, error: { code, message } }`

## POST /api/chat
Request:
```json
{ "sessionId": "string", "message": "string" }
```
Response:
```json
{ "ok": true, "data": { "reply": "string" } }
```

Validation:
- sessionId required, min length 8
- message required, trimmed, length 1..2000
- rate limit by sessionId

Behavior:
- append user message
- build prompt with summary + last N messages (N=10)
- call Workers AI model
- append assistant message
- return assistant reply

## POST /api/summarize
Request:
```json
{ "sessionId": "string" }
```
Response:
```json
{ "ok": true, "data": { "summary": "string" } }
```

Behavior:
- fetch last M messages (M=50) from DO
- call Workers AI with summarization prompt
- store summary in DO meta table
- return summary

## GET /api/export?sessionId=...
Response:
```json
{
  "ok": true,
  "data": {
    "sessionId": "string",
    "createdAt": 0,
    "updatedAt": 0,
    "summary": "string|null",
    "messages": [
      { "role": "user|assistant|system", "content": "string", "ts": 0 }
    ]
  }
}
```

---

# Durable Object specification

## Durable Object name
- `ChatSessionDO`

## SQLite schema
### Table: messages
- id INTEGER PRIMARY KEY AUTOINCREMENT
- role TEXT NOT NULL CHECK(role in ('user','assistant','system'))
- content TEXT NOT NULL
- ts INTEGER NOT NULL

Index (optional):
- index on ts

### Table: meta
- key TEXT PRIMARY KEY
- value TEXT NOT NULL

Meta keys:
- createdAt (unix ms)
- updatedAt (unix ms)
- summary (string)

## DO methods (internal)
- `init()`: create tables if needed
- `appendMessage(role, content, ts)`
- `getRecentMessages(limit)`
- `setSummary(summary)`
- `getSummary()`
- `exportSession()`

---

# Frontend specification (Pages)

## Requirements
- Simple chat UI:
  - transcript area
  - text input
  - send button
  - summarize button
  - export button
  - new chat button (resets sessionId)

## Behavior
- On load: ensure sessionId in localStorage
- On send:
  - disable send while pending
  - POST /api/chat
  - append user and assistant to UI transcript
- On summarize:
  - POST /api/summarize
  - show summary in UI (above transcript)
- On export:
  - open /api/export in new tab or download JSON

## Implementation choice
- Prefer minimal vanilla JS or small React app.
- Keep build simple to reduce time.

---

# Prompts (stable and small)

## System prompt (example)
You are a helpful, concise assistant. Ask clarifying questions when necessary. Do not output secrets or unsafe instructions.

## Chat prompt assembly
- system prompt
- summary (if exists): "Session summary: ... "
- last N messages
- current user message

## Summarization prompt
Summarize the conversation in 5 bullet points focusing on user goals, constraints, and decisions. Keep under 120 words.

---

# Acceptance criteria (definition of done)
- Deployed Pages URL loads and can chat end-to-end.
- Refresh keeps the same session and history persists.
- Summarize endpoint generates and stores a summary, visible after refresh.
- Export endpoint returns correct JSON structure.
- README includes:
  - what it is
  - architecture diagram
  - local dev steps
  - deploy steps
  - endpoints
- No paid services required.

---

# Non-goals (do not build)
- Voice input (optional stretch only)
- Streaming tokens
- Multi-user accounts / auth
- Vector database / embeddings
- Complex moderation pipelines
- Fancy UI or design system

---

# Repo structure (required)
```
/worker
  wrangler.toml
  src/
    index.ts
    chatSessionDO.ts
  README-worker.md (optional)
/web
  package.json (if needed)
  public/
  src/
  README-web.md (optional)
README.md
LICENSE (optional)
```

---

# Local development notes
- Use Wrangler to run Worker locally.
- Use Pages dev for the frontend.
- Configure dev proxy so frontend can call Worker without CORS pain.

---

# Deployment notes
- Deploy Worker first, then Pages.
- Configure Pages environment variable for API base URL if needed.

---

# Quality checklist
- TypeScript types everywhere
- Small functions, clear naming
- Input validation and errors
- Limits for message length and history
- No secrets committed
