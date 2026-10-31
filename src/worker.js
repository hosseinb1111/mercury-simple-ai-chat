import { SYSTEM_PROMPT } from "./prompt.js";

// Stateless API. Nothing is stored: every request carries the conversation it needs.
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 60000;
const FILE_TEXT_CHARS = 40000;
const DEFAULT_API_URL = "https://api.inceptionlabs.ai/v1/chat/completions";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const maxBytes = (env) => Math.max(1, Number(env.MAX_UPLOAD_MB) || 10) * 1024 * 1024;

function requireAI(env) {
  if (!env.AI) throw new HttpError(503, "The Cloudflare AI binding is not enabled for this deployment.");
}

function temperature(env) {
  const raw = String(env.INCEPTION_TEMPERATURE ?? "").trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return 0.3;
  return Math.min(2, Math.max(0, n));
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/config" && request.method === "GET") {
        return json({
          title: env.APP_TITLE || "Mercury Chat",
          model: env.INCEPTION_MODEL || "mercury-3",
          configured: Boolean(env.INCEPTION_API_KEY),
          maxUploadMb: Number(env.MAX_UPLOAD_MB) || 10,
          features: { ai: Boolean(env.AI) },
        });
      }
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (pathname === "/api/chat") return await chat(request, env);
      if (pathname === "/api/transcribe") return await transcribe(request, env);
      if (pathname === "/api/convert") return await convert(request, env);
      if (pathname === "/api/describe") return await describe(request, env);
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(pathname, error);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};

/** Streams Mercury 3 (OpenAI-compatible SSE) straight back to the browser. */
async function chat(request, env) {
  if (!env.INCEPTION_API_KEY) throw new HttpError(500, "INCEPTION_API_KEY is not set on the server.");
  const body = await request.json().catch(() => null);
  const incoming = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  if (!incoming.length) throw new HttpError(400, "messages is required.");

  const messages = [{ role: "system", content: env.SYSTEM_PROMPT || SYSTEM_PROMPT }];
  for (const m of incoming) {
    // Clients may only send user/assistant turns, so they cannot inject a system prompt.
    if (m?.role !== "user" && m?.role !== "assistant") {
      throw new HttpError(400, "Only user and assistant messages are accepted.");
    }
    const content = String(m.content ?? "");
    if (content.length > MAX_MESSAGE_CHARS) throw new HttpError(413, "A message is too long.");
    messages.push({ role: m.role, content });
  }

  const payload = {
    model: env.INCEPTION_MODEL || "mercury-3",
    messages,
    stream: true,
    temperature: temperature(env),
  };
  const effort = String(env.INCEPTION_REASONING_EFFORT ?? "medium").trim().toLowerCase();
  if (effort && effort !== "off" && effort !== "none") payload.reasoning_effort = effort;

  const upstream = await fetch(env.INCEPTION_API_URL || DEFAULT_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.INCEPTION_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!upstream.ok) {
    console.error("inception", upstream.status, (await upstream.text().catch(() => "")).slice(0, 300));
    throw new HttpError(502, `The model request failed (HTTP ${upstream.status}).`);
  }
  return new Response(upstream.body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/** Voice note (base64) -> text with Whisper on Workers AI. */
async function transcribe(request, env) {
  requireAI(env);
  const body = await request.json().catch(() => null);
  const audio = typeof body?.audio === "string" ? body.audio : "";
  if (!audio) throw new HttpError(400, "audio (base64) is required.");
  if (audio.length > (maxBytes(env) * 4) / 3 + 1024) throw new HttpError(413, "The recording is too large.");

  let result;
  try {
    result = await env.AI.run(env.TRANSCRIBE_MODEL || "@cf/openai/whisper-large-v3-turbo", { audio });
  } catch (error) {
    console.error("whisper", error);
    throw new HttpError(502, "Transcription failed. Try a shorter recording.");
  }
  const text = String(result?.text ?? "").trim();
  if (!text) throw new HttpError(422, "No speech was detected.");
  return json({ text });
}

/** Any supported document (PDF, DOCX, XLSX, ...) -> Markdown with Cloudflare toMarkdown. */
async function convert(request, env) {
  requireAI(env);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new HttpError(400, "The file is empty.");
  if (bytes.byteLength > maxBytes(env)) {
    throw new HttpError(413, `The file is too large (max ${Number(env.MAX_UPLOAD_MB) || 10} MB).`);
  }
  const name = safeName(request.headers.get("x-file-name"));
  const mime = request.headers.get("content-type") || "application/octet-stream";

  let result;
  try {
    result = await env.AI.toMarkdown({ name, blob: new Blob([bytes], { type: mime }) });
  } catch (error) {
    console.error("toMarkdown", error);
    throw new HttpError(422, "This file couldn't be converted.");
  }
  const item = Array.isArray(result) ? result[0] : result;
  if (!item?.data || item.format === "error") {
    throw new HttpError(422, item?.error || "This file type can't be converted.");
  }
  return json({ name, markdown: String(item.data).slice(0, FILE_TEXT_CHARS) });
}

/** Image question -> answer from the vision model (Llama 4 Scout, as in the bot). */
async function describe(request, env) {
  requireAI(env);
  const body = await request.json().catch(() => null);
  const image = typeof body?.image === "string" ? body.image : "";
  const mime = String(body?.mime || "");
  if (!image || !/^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
    throw new HttpError(400, "A PNG, JPEG, WebP or GIF image is required.");
  }
  if (image.length > (maxBytes(env) * 4) / 3 + 1024) throw new HttpError(413, "The image is too large.");
  const prompt = String(body?.prompt || "Describe this image in detail.").slice(0, 4000);

  let result;
  try {
    result = await env.AI.run(env.VISION_MODEL || "@cf/meta/llama-4-scout-17b-16e-instruct", {
      messages: [
        {
          role: "system",
          content: "You are a helpful, accurate visual assistant. Answer questions about images precisely. Never invent details you cannot see.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${image}` } },
          ],
        },
      ],
      max_tokens: 1024,
    });
  } catch (error) {
    console.error("vision", error);
    throw new HttpError(502, "Image analysis failed. Try again.");
  }
  const text = String(result?.response ?? result?.result?.response ?? "").trim();
  if (!text) throw new HttpError(502, "The vision model returned no answer.");
  return json({ text });
}

function safeName(raw) {
  try {
    return decodeURIComponent(raw || "file").slice(0, 200) || "file";
  } catch {
    return "file";
  }
}
