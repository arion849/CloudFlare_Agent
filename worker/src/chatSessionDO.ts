/**
 * ChatSessionDO – Durable Object per sessionId.
 * SQLite-backed: messages + meta tables.
 * Methods: init, appendMessage, getRecentMessages, setSummary, getSummary, exportSession.
 */

export interface Env {
  CHAT_SESSION: DurableObjectNamespace;
}

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRow {
  role: MessageRole;
  content: string;
  ts: number;
}

export interface ExportData {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  summary: string | null;
  messages: MessageRow[];
}

type DORequest =
  | { type: "init" }
  | { type: "appendMessage"; role: MessageRole; content: string; ts: number }
  | { type: "getRecentMessages"; limit: number }
  | { type: "setSummary"; summary: string }
  | { type: "getSummary" }
  | { type: "exportSession" };

export class ChatSessionDO implements DurableObject {
  private sessionId: string;
  private state: DurableObjectState;
  private sql: SqlStorage | null = null;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.sessionId = state.id.toString();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/" || request.method !== "POST") {
      return jsonResponse({ ok: false, error: { code: "bad_request", message: "POST / only" } }, 400);
    }

    let body: DORequest;
    try {
      body = (await request.json()) as DORequest;
    } catch {
      return jsonResponse({ ok: false, error: { code: "bad_request", message: "Invalid JSON" } }, 400);
    }

    try {
      this.ensureInit();
      let result: unknown;

      switch (body.type) {
        case "init":
          result = { done: true };
          break;
        case "appendMessage":
          this.appendMessage(body.role, body.content, body.ts);
          result = { done: true };
          break;
        case "getRecentMessages":
          result = this.getRecentMessages(body.limit);
          break;
        case "setSummary":
          this.setSummary(body.summary);
          result = { done: true };
          break;
        case "getSummary":
          result = this.getSummary();
          break;
        case "exportSession":
          result = this.exportSession();
          break;
        default:
          return jsonResponse({ ok: false, error: { code: "bad_request", message: "Unknown request type" } }, 400);
      }

      return jsonResponse({ ok: true, data: result });
    } catch (e) {
      const message = e instanceof Error ? e.message : "DO error";
      return jsonResponse({ ok: false, error: { code: "internal", message } }, 500);
    }
  }

  private ensureInit(): void {
    if (this.sql) return;
    this.sql = this.state.storage.sql;
    this.init();
  }

  /** Create tables if needed. */
  init(): void {
    const s = this.sql!;
    s.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const rows = s.exec("SELECT value FROM meta WHERE key = 'createdAt'").toArray();
    if (rows.length === 0) {
      const now = Date.now();
      s.exec("INSERT INTO meta (key, value) VALUES ('createdAt', ?), ('updatedAt', ?)", now, now);
    }
  }

  appendMessage(role: MessageRole, content: string, ts: number): void {
    const s = this.sql!;
    s.exec("INSERT INTO messages (role, content, ts) VALUES (?, ?, ?)", role, content, ts);
    s.exec("UPDATE meta SET value = ? WHERE key = 'updatedAt'", ts);
  }

  getRecentMessages(limit: number): MessageRow[] {
    const s = this.sql!;
    const rows = s.exec(
      "SELECT role, content, ts FROM messages ORDER BY ts DESC LIMIT ?",
      limit
    ).toArray() as { role: string; content: string; ts: number }[];
    const out = rows.map((r) => ({
      role: r.role as MessageRole,
      content: r.content,
      ts: r.ts,
    }));
    return out.reverse();
  }

  setSummary(summary: string): void {
    const s = this.sql!;
    const now = Date.now();
    s.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('summary', ?)", summary);
    s.exec("UPDATE meta SET value = ? WHERE key = 'updatedAt'", now);
  }

  getSummary(): string | null {
    const s = this.sql!;
    const rows = s.exec("SELECT value FROM meta WHERE key = 'summary'").toArray() as { value: string }[];
    return rows.length > 0 ? rows[0].value : null;
  }

  exportSession(): ExportData {
    const s = this.sql!;
    const metaRows = s.exec("SELECT key, value FROM meta").toArray() as { key: string; value: string }[];
    const meta: Record<string, string> = {};
    for (const r of metaRows) {
      meta[r.key] = r.value;
    }
    const messagesRows = s.exec("SELECT role, content, ts FROM messages ORDER BY ts ASC").toArray() as {
      role: string;
      content: string;
      ts: number;
    }[];
    const messages: MessageRow[] = messagesRows.map((r) => ({
      role: r.role as MessageRole,
      content: r.content,
      ts: r.ts,
    }));
    return {
      sessionId: this.sessionId,
      createdAt: Number(meta.createdAt ?? 0),
      updatedAt: Number(meta.updatedAt ?? 0),
      summary: meta.summary ?? null,
      messages,
    };
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
