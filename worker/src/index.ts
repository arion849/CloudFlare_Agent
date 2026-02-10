/**
 * Worker: /api/chat, /api/summarize, /api/export, /api/upload, /api/file.
 * Orchestrates ChatSessionDO, Workers AI, and R2.
 */

import { ChatSessionDO, type MessageRow } from "./chatSessionDO";

const SYSTEM_PROMPT =
  "You are a helpful, concise assistant. Ask clarifying questions when necessary. Do not output secrets or unsafe instructions.";
const SUMMARIZE_PROMPT =
  "Summarize the conversation in 5 bullet points focusing on user goals, constraints, and decisions. Keep under 120 words.";
const LLAMA_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

export interface Env {
  CHAT_SESSION: DurableObjectNamespace;
  AI: Ai;
  BUCKET: R2Bucket;
  MESSAGE_MAX_LENGTH?: string;
  MESSAGE_HISTORY_LIMIT?: string;
  SUMMARIZE_MESSAGE_LIMIT?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_MS?: string;
}

const DEFAULT_MESSAGE_MAX = 2000;
const DEFAULT_HISTORY_LIMIT = 10;
const DEFAULT_SUMMARIZE_LIMIT = 50;
const DEFAULT_RATE_REQUESTS = 10;
const DEFAULT_RATE_WINDOW_MS = 60_000;

const MAX_UPLOAD_BYTES = 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md", ".json"];
const FILE_RESPONSE_CAP_BYTES = 100_000;

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 200) || "file";
}

function getFileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

const rateLimitMap = new Map<string, number[]>();

function getConfig(env: Env) {
  return {
    messageMax: env.MESSAGE_MAX_LENGTH ? parseInt(env.MESSAGE_MAX_LENGTH, 10) : DEFAULT_MESSAGE_MAX,
    historyLimit: env.MESSAGE_HISTORY_LIMIT ? parseInt(env.MESSAGE_HISTORY_LIMIT, 10) : DEFAULT_HISTORY_LIMIT,
    summarizeLimit: env.SUMMARIZE_MESSAGE_LIMIT ? parseInt(env.SUMMARIZE_MESSAGE_LIMIT, 10) : DEFAULT_SUMMARIZE_LIMIT,
    rateRequests: env.RATE_LIMIT_REQUESTS ? parseInt(env.RATE_LIMIT_REQUESTS, 10) : DEFAULT_RATE_REQUESTS,
    rateWindowMs: env.RATE_LIMIT_WINDOW_MS ? parseInt(env.RATE_LIMIT_WINDOW_MS, 10) : DEFAULT_RATE_WINDOW_MS,
  };
}

function jsonResponse(body: object, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers as Record<string, string>) },
  });
}

function checkRateLimit(sessionId: string, config: ReturnType<typeof getConfig>): boolean {
  const now = Date.now();
  const windowStart = now - config.rateWindowMs;
  let timestamps = rateLimitMap.get(sessionId) ?? [];
  timestamps = timestamps.filter((t) => t > windowStart);
  if (timestamps.length >= config.rateRequests) return false;
  timestamps.push(now);
  rateLimitMap.set(sessionId, timestamps);
  return true;
}

function getDOStub(env: Env, sessionId: string): DurableObjectStub {
  const id = env.CHAT_SESSION.idFromName(sessionId);
  return env.CHAT_SESSION.get(id);
}

async function doRequest<T>(
  stub: DurableObjectStub,
  body: object
): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }> {
  const res = await stub.fetch("https://do/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const config = getConfig(env);
    const corsHeaders = { "Access-Control-Allow-Origin": "*" };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (url.pathname === "/api/upload" && request.method === "POST") {
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return jsonResponse(
          { ok: false, error: { code: "bad_request", message: "Invalid multipart body" } },
          400,
          corsHeaders
        );
      }
      const raw = formData.get("file");
      if (!raw || typeof raw === "string") {
        return jsonResponse(
          { ok: false, error: { code: "validation_error", message: "Missing or invalid file field (use field name 'file')" } },
          400,
          corsHeaders
        );
      }
      const file = raw as File;
      const ext = getFileExtension(file.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return jsonResponse(
          { ok: false, error: { code: "validation_error", message: "Only .txt, .md, and .json files are allowed" } },
          400,
          corsHeaders
        );
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return jsonResponse(
          { ok: false, error: { code: "validation_error", message: "File too large. Maximum size is 1 MB." } },
          400,
          corsHeaders
        );
      }
      const fileId = crypto.randomUUID();
      const safeName = sanitizeFilename(file.name) || "file" + ext;
      const key = `uploads/${fileId}-${safeName}`;
      const body = await file.arrayBuffer();
      try {
        await env.BUCKET.put(key, body, {
          httpMetadata: { contentType: file.type || "text/plain" },
          customMetadata: { originalName: file.name },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        return jsonResponse({ ok: false, error: { code: "upload_error", message: msg } }, 500, corsHeaders);
      }
      return jsonResponse(
        {
          ok: true,
          data: { fileId, filename: file.name, contentType: file.type || "text/plain", size: file.size },
        },
        200,
        corsHeaders
      );
    }

    if (url.pathname === "/api/file" && request.method === "GET") {
      const fileId = url.searchParams.get("fileId")?.trim();
      if (!fileId) {
        return jsonResponse(
          { ok: false, error: { code: "validation_error", message: "fileId query parameter required" } },
          400,
          corsHeaders
        );
      }
      const list = await env.BUCKET.list({ prefix: `uploads/${fileId}-`, limit: 1 });
      const obj = list.objects[0];
      if (!obj) {
        return jsonResponse(
          { ok: false, error: { code: "not_found", message: "File not found" } },
          404,
          corsHeaders
        );
      }
      const r2Object = await env.BUCKET.get(obj.key);
      if (!r2Object) {
        return jsonResponse(
          { ok: false, error: { code: "not_found", message: "File not found" } },
          404,
          corsHeaders
        );
      }
      const originalName = (r2Object.customMetadata?.originalName as string) || obj.key.replace(/^uploads\/[^-]+-/, "");
      let content: string;
      const stream = r2Object.body;
      const cap = Math.min(r2Object.size, FILE_RESPONSE_CAP_BYTES);
      const buf = new Uint8Array(cap);
      let offset = 0;
      const reader = stream.getReader();
      try {
        while (offset < cap) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value.slice(0, cap - offset);
          buf.set(chunk, offset);
          offset += chunk.length;
        }
      } finally {
        reader.releaseLock();
      }
      const decoder = new TextDecoder("utf-8", { fatal: false });
      content = decoder.decode(buf.slice(0, offset));
      return jsonResponse(
        { ok: true, data: { fileId, filename: originalName, content } },
        200,
        corsHeaders
      );
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      let body: { sessionId?: string; message?: string; fileId?: string };
      try {
        body = (await request.json()) as { sessionId?: string; message?: string; fileId?: string };
      } catch {
        return jsonResponse({ ok: false, error: { code: "bad_request", message: "Invalid JSON" } }, 400, corsHeaders);
      }
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const fileId = typeof body.fileId === "string" ? body.fileId.trim() : undefined;
      if (sessionId.length < 8) {
        return jsonResponse(
          { ok: false, error: { code: "validation_error", message: "sessionId required, min length 8" } },
          400,
          corsHeaders
        );
      }
      if (message.length < 1 || message.length > config.messageMax) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "validation_error",
              message: `message required, length 1..${config.messageMax}`,
            },
          },
          400,
          corsHeaders
        );
      }
      if (!checkRateLimit(sessionId, config)) {
        return jsonResponse(
          { ok: false, error: { code: "rate_limit", message: "Too many requests; try again later" } },
          429,
          corsHeaders
        );
      }

      let userContentForAI = message;
      if (fileId) {
        const list = await env.BUCKET.list({ prefix: `uploads/${fileId}-`, limit: 1 });
        const obj = list.objects[0];
        if (obj) {
          const r2Object = await env.BUCKET.get(obj.key);
          if (r2Object) {
            const cap = Math.min(r2Object.size, FILE_RESPONSE_CAP_BYTES);
            const buf = new Uint8Array(cap);
            let offset = 0;
            const reader = r2Object.body.getReader();
            try {
              while (offset < cap) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = value.slice(0, cap - offset);
                buf.set(chunk, offset);
                offset += chunk.length;
              }
            } finally {
              reader.releaseLock();
            }
            const fileContent = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, offset));
            userContentForAI = `[Attached file]\n${fileContent}\n\n---\n\n${message}`;
          }
        }
      }

      const stub = getDOStub(env, sessionId);
      const ts = Date.now();

      const appendRes = await doRequest(stub, { type: "appendMessage", role: "user", content: message, ts });
      if (!appendRes.ok) {
        return jsonResponse(
          { ok: false, error: appendRes.error },
          appendRes.error.code === "internal" ? 500 : 400,
          corsHeaders
        );
      }

      const [summaryRes, messagesRes] = await Promise.all([
        doRequest<string | null>(stub, { type: "getSummary" }),
        doRequest<MessageRow[]>(stub, { type: "getRecentMessages", limit: config.historyLimit }),
      ]);
      if (!summaryRes.ok || !messagesRes.ok) {
        const failed = !summaryRes.ok ? summaryRes : messagesRes;
        return jsonResponse(
          { ok: false, error: (failed as { ok: false; error: { code: string; message: string } }).error },
          500,
          corsHeaders
        );
      }

      const summary = summaryRes.data;
      const recent = messagesRes.data;

      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: SYSTEM_PROMPT },
      ];
      if (summary) {
        messages.push({ role: "system", content: `Session summary: ${summary}` });
      }
      for (const m of recent) {
        messages.push({ role: m.role as "user" | "assistant", content: m.content });
      }
      messages.push({ role: "user", content: userContentForAI });

      let reply: string;
      try {
        const aiRes = (await env.AI.run(LLAMA_MODEL, { messages })) as { response?: string };
        reply = typeof aiRes?.response === "string" ? aiRes.response : String(aiRes?.response ?? "No response.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "AI error";
        return jsonResponse(
          { ok: false, error: { code: "ai_error", message: msg } },
          502,
          corsHeaders
        );
      }

      await doRequest(stub, { type: "appendMessage", role: "assistant", content: reply, ts: Date.now() });

      return jsonResponse({ ok: true, data: { reply } }, 200, corsHeaders);
    }

    if (url.pathname === "/api/summarize" && request.method === "POST") {
      let body: { sessionId?: string };
      try {
        body = (await request.json()) as { sessionId?: string };
      } catch {
        return jsonResponse(
          { ok: false, error: { code: "bad_request", message: "Invalid JSON" } },
          400,
          corsHeaders
        );
      }
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (sessionId.length < 8) {
        return jsonResponse(
          { ok: false, error: { code: "validation_error", message: "sessionId required, min length 8" } },
          400,
          corsHeaders
        );
      }
      if (!checkRateLimit(sessionId, config)) {
        return jsonResponse(
          { ok: false, error: { code: "rate_limit", message: "Too many requests; try again later" } },
          429,
          corsHeaders
        );
      }

      const stub = getDOStub(env, sessionId);
      const messagesRes = await doRequest<MessageRow[]>(stub, {
        type: "getRecentMessages",
        limit: config.summarizeLimit,
      });
      if (!messagesRes.ok) {
        return jsonResponse({ ok: false, error: messagesRes.error }, 500, corsHeaders);
      }
      const recent = messagesRes.data;
      const transcript = recent
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      const summarizationPrompt = transcript
        ? `${SUMMARIZE_PROMPT}\n\nConversation:\n${transcript}`
        : "No messages in this session.";
      let summary: string;
      try {
        const aiRes = (await env.AI.run(LLAMA_MODEL, {
          messages: [{ role: "user", content: summarizationPrompt }],
        })) as { response?: string };
        summary = typeof aiRes?.response === "string" ? aiRes.response : String(aiRes?.response ?? "No summary.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "AI error";
        return jsonResponse(
          { ok: false, error: { code: "ai_error", message: msg } },
          502,
          corsHeaders
        );
      }
      await doRequest(stub, { type: "setSummary", summary });
      return jsonResponse({ ok: true, data: { summary } }, 200, corsHeaders);
    }

    if (url.pathname === "/api/export" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
      if (sessionId.length < 8) {
        return jsonResponse(
          { ok: false, error: { code: "validation_error", message: "sessionId query param required, min length 8" } },
          400,
          corsHeaders
        );
      }
      const stub = getDOStub(env, sessionId);
      const exportRes = await doRequest<
        { sessionId: string; createdAt: number; updatedAt: number; summary: string | null; messages: MessageRow[] }
      >(stub, { type: "exportSession" });
      if (!exportRes.ok) {
        return jsonResponse({ ok: false, error: exportRes.error }, 500, corsHeaders);
      }
      const data = { ...exportRes.data, sessionId };
      return jsonResponse({ ok: true, data }, 200, corsHeaders);
    }

    return jsonResponse(
      { ok: false, error: { code: "not_found", message: "Not found" } },
      404,
      corsHeaders
    );
  },
};

export { ChatSessionDO };
