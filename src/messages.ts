import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

// Inbound Anthropic Messages API (/v1/messages) support so Claude Code — which speaks
// the Anthropic wire protocol — can point at OmniCodex and route to ANY provider.
// Strategy: translate Anthropic request -> internal Responses body, run it through the
// existing provider adapters (which emit OpenAI-Responses SSE) captured in-memory, then
// translate that canonical stream back into Anthropic Messages output.

type Json = Record<string, unknown>;

export function anthropicToResponsesBody(body: Json): Json {
  const input: Json[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Json;
    const role = m.role === "assistant" ? "assistant" : "user";
    const textType = role === "assistant" ? "output_text" : "input_text";
    const content = m.content;
    if (typeof content === "string") {
      input.push({ type: "message", role, content: [{ type: textType, text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const textParts: Json[] = [];
    for (const rawPart of content) {
      const p = rawPart as Json;
      if (p?.type === "text") textParts.push({ type: textType, text: String(p.text ?? "") });
      else if (p?.type === "tool_use") input.push({ type: "function_call", call_id: String(p.id ?? randomUUID()), name: String(p.name ?? ""), arguments: JSON.stringify(p.input ?? {}) });
      else if (p?.type === "tool_result") input.push({ type: "function_call_output", call_id: String(p.tool_use_id ?? ""), output: typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "") });
    }
    if (textParts.length) input.push({ type: "message", role, content: textParts });
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((t) => {
        const tt = t as Json;
        if (!tt?.name) return [];
        return [{ type: "function", name: String(tt.name), description: tt.description, parameters: tt.input_schema ?? { type: "object", properties: {} } }];
      })
    : undefined;
  const system = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system) ? (body.system as Json[]).map((s) => String((s as Json)?.text ?? "")).join("\n") : undefined;
  return {
    model: body.model,
    instructions: system || undefined,
    input,
    tools: tools && tools.length ? tools : undefined,
    max_output_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    stream: true,
  };
}

// Minimal in-memory ServerResponse that captures everything an adapter writes.
export class CollectorResponse {
  chunks: string[] = [];
  headersSent = false;
  writeHead(): this { this.headersSent = true; return this; }
  setHeader(): this { return this; }
  write(chunk: string | Uint8Array): boolean { this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; }
  end(chunk?: string | Uint8Array): this { if (chunk) this.write(chunk); return this; }
  once(): this { return this; }
  get text(): string { return this.chunks.join(""); }
}

export type ParsedResponses = { text: string; tools: Array<{ id: string; name: string; arguments: string }>; usage?: Json };

export function parseResponsesSSE(sse: string): ParsedResponses {
  let text = "";
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Json | undefined;
  for (const block of sse.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    let evt: Json;
    try { evt = JSON.parse(dataLine.slice(5).trim()) as Json; } catch { continue; }
    const type = String(evt.type);
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      text += evt.delta;
    } else if (type === "response.output_item.done") {
      const item = evt.item as Json | undefined;
      if (item?.type === "function_call") {
        toolsByIndex.set(Number(evt.output_index ?? toolsByIndex.size + 1), {
          id: String(item.call_id ?? item.id ?? randomUUID()),
          name: String(item.name ?? ""),
          arguments: String(item.arguments ?? "{}"),
        });
      }
    } else if (type === "response.completed") {
      usage = (evt.response as Json | undefined)?.usage as Json | undefined;
    }
  }
  return { text, tools: [...toolsByIndex.values()], usage };
}

function anthropicUsage(usage: Json | undefined): Json {
  return { input_tokens: Number(usage?.input_tokens ?? 0), output_tokens: Number(usage?.output_tokens ?? 0) };
}

export function anthropicJSON(model: string, parsed: ParsedResponses): Json {
  const content: Json[] = [];
  if (parsed.text) content.push({ type: "text", text: parsed.text });
  for (const t of parsed.tools) {
    let inputObj: unknown = {};
    try { inputObj = JSON.parse(t.arguments || "{}"); } catch { inputObj = {}; }
    content.push({ type: "tool_use", id: t.id, name: t.name, input: inputObj });
  }
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: parsed.tools.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: anthropicUsage(parsed.usage),
  };
}

function sse(res: ServerResponse, type: string, data: Json): void {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

// Real-time translator: adapters write OpenAI-Responses SSE into this object; it parses
// each event as it arrives and emits Anthropic Messages SSE to the real response, token by token.
export class AnthropicSSETranslator {
  private res: ServerResponse;
  private model: string;
  private buffer = "";
  private started = false;
  private headers = false;
  private nextIndex = 0;
  private blockIndex = -1;
  private textOpen = false;
  private toolOpen = false;
  private toolSeen = false;
  private usage: Json | undefined;
  private ended = false;
  headersSent = false;

  constructor(res: ServerResponse, model: string) { this.res = res; this.model = model; }

  private raw(type: string, data: Json): void { this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }

  private ensure(): void {
    if (!this.headers) {
      this.headers = true;
      this.headersSent = true;
      this.res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    }
    if (!this.started) {
      this.started = true;
      this.raw("message_start", { message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, usage: anthropicUsage(undefined) } });
    }
  }

  writeHead(): this { this.ensure(); return this; }
  setHeader(): this { return this; }
  once(event: string, cb: (...a: unknown[]) => void): this { this.res.once(event, cb as never); return this; }

  write(chunk: string | Uint8Array): boolean {
    this.ensure();
    this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const parts = this.buffer.split("\n\n");
    this.buffer = parts.pop() ?? "";
    for (const b of parts) this.consume(b);
    return true;
  }

  private openText(): void {
    if (this.textOpen) return;
    this.closeBlock();
    this.blockIndex = this.nextIndex++;
    this.textOpen = true;
    this.raw("content_block_start", { index: this.blockIndex, content_block: { type: "text", text: "" } });
  }
  private closeBlock(): void {
    if (this.blockIndex >= 0) { this.raw("content_block_stop", { index: this.blockIndex }); this.blockIndex = -1; this.textOpen = false; this.toolOpen = false; }
  }

  private consume(block: string): void {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    let evt: Json;
    try { evt = JSON.parse(line.slice(5).trim()) as Json; } catch { return; }
    const t = String(evt.type);
    if (t === "response.output_text.delta" && typeof evt.delta === "string") {
      this.openText();
      this.raw("content_block_delta", { index: this.blockIndex, delta: { type: "text_delta", text: evt.delta } });
    } else if (t === "response.output_item.added" && (evt.item as Json | undefined)?.type === "function_call") {
      const item = evt.item as Json;
      this.closeBlock();
      this.blockIndex = this.nextIndex++;
      this.toolOpen = true;
      this.toolSeen = true;
      this.raw("content_block_start", { index: this.blockIndex, content_block: { type: "tool_use", id: String(item.call_id ?? item.id ?? randomUUID()), name: String(item.name ?? ""), input: {} } });
    } else if (t === "response.function_call_arguments.delta" && this.toolOpen && typeof evt.delta === "string") {
      this.raw("content_block_delta", { index: this.blockIndex, delta: { type: "input_json_delta", partial_json: evt.delta } });
    } else if (t === "response.output_item.done") {
      const item = evt.item as Json | undefined;
      if (item?.type === "function_call") {
        if (this.toolOpen) {
          this.closeBlock();
        } else {
          this.closeBlock();
          this.blockIndex = this.nextIndex++;
          this.toolSeen = true;
          this.raw("content_block_start", { index: this.blockIndex, content_block: { type: "tool_use", id: String(item.call_id ?? item.id ?? randomUUID()), name: String(item.name ?? ""), input: {} } });
          this.raw("content_block_delta", { index: this.blockIndex, delta: { type: "input_json_delta", partial_json: String(item.arguments ?? "{}") } });
          this.closeBlock();
        }
      } else if (item?.type === "message") {
        this.closeBlock();
      }
    } else if (t === "response.completed") {
      this.usage = (evt.response as Json | undefined)?.usage as Json | undefined;
    }
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk) this.write(chunk);
    if (this.buffer.trim()) { this.consume(this.buffer); this.buffer = ""; }
    if (this.ended) return this;
    this.ended = true;
    this.ensure();
    this.closeBlock();
    this.raw("message_delta", { delta: { stop_reason: this.toolSeen ? "tool_use" : "end_turn" }, usage: anthropicUsage(this.usage) });
    this.raw("message_stop", {});
    this.res.end();
    return this;
  }
}
