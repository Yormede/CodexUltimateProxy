import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, createSign, createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedModel } from "./registry.ts";

type Json = Record<string, unknown>;

const cachePath = join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "reasoning_cache.json");
const reasoningCache = new Map<string, string>();

try {
  if (existsSync(cachePath)) {
    const raw = readFileSync(cachePath, "utf8");
    const data = JSON.parse(raw);
    for (const [k, v] of Object.entries(data)) {
      if (typeof k === "string" && typeof v === "string") {
        reasoningCache.set(k, v);
      }
    }
  }
} catch (e) {
  console.error("Impossible de charger le cache de raisonnement :", e);
}

function addToReasoningCache(content: string, reasoning: string): void {
  if (reasoningCache.size >= 500) {
    const firstKey = reasoningCache.keys().next().value;
    if (firstKey !== undefined) reasoningCache.delete(firstKey);
  }
  reasoningCache.set(content, reasoning);

  try {
    const obj = Object.fromEntries(reasoningCache.entries());
    writeFileSync(cachePath, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("Impossible de sauvegarder le cache de raisonnement :", e);
  }
}

function event(res: ServerResponse, value: Json): void {
  const type = String(value.type);
  res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function responseUsage(usage: Json | undefined): Json {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  return {
    input_tokens: input,
    input_tokens_details: null,
    output_tokens: output,
    output_tokens_details: null,
    total_tokens: Number(usage?.total_tokens ?? input + output)
  };
}

function outputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as Json;
    if (typeof item.text === "string") return item.text;
    return outputText(item.content);
  }).join("");
}

function imagePart(part: Json): Json | undefined {
  const url = part.image_url ?? part.url;
  if (typeof url === "string") return { type: "image_url", image_url: { url } };
  if (url && typeof url === "object" && typeof (url as Json).url === "string") {
    return { type: "image_url", image_url: { url: (url as Json).url } };
  }
  return undefined;
}

function chatContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const part = raw as Json;
    if (["input_text", "output_text", "text"].includes(String(part.type))) {
      return [{ type: "text", text: String(part.text ?? "") }];
    }
    if (["input_image", "image_url"].includes(String(part.type))) {
      const image = imagePart(part);
      return image ? [image] : [];
    }
    return [];
  });
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
  return parts;
}

export function toChatRequest(body: Json, model: string): Json {
  const messages: Json[] = [];
  let pendingAssistantToolCalls: Json[] = [];

  const flushPendingAssistantToolCalls = (): void => {
    if (!pendingAssistantToolCalls.length) return;
    const fcMsg: Json = {
      role: "assistant",
      content: "",
      tool_calls: pendingAssistantToolCalls
    };
    if (model.includes("deepseek") || model.includes("reasoner")) {
      fcMsg.reasoning_content = "Thinking...";
    }
    messages.push(fcMsg);
    pendingAssistantToolCalls = [];
  };

  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = Array.isArray(body.input) ? body.input : [{ type: "message", role: "user", content: body.input }];
  let hasAssistantWithoutReasoning = false;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Json;
    if (item.type === "message") {
      flushPendingAssistantToolCalls();
      const role = item.role === "developer" ? "system" : String(item.role ?? "user");
      const content = chatContent(item.content);
      const msg: Json = { role, content };
      if (role === "assistant") {
        if (typeof content === "string") {
          const cached = reasoningCache.get(content);
          if (cached) {
            msg.reasoning_content = cached;
          } else if (model.includes("deepseek") || model.includes("reasoner")) {
            msg.reasoning_content = "Thinking...";
          } else {
            hasAssistantWithoutReasoning = true;
          }
        } else if (model.includes("deepseek") || model.includes("reasoner")) {
          msg.reasoning_content = "Thinking...";
        } else {
          hasAssistantWithoutReasoning = true;
        }
      }
      messages.push(msg);
    } else if (item.type === "function_call") {
      pendingAssistantToolCalls.push({
        id: String(item.call_id ?? item.id ?? randomUUID()),
        type: "function",
        function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "{}") }
      });
    } else if (item.type === "function_call_output") {
      flushPendingAssistantToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? item.tool_call_id ?? ""),
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null)
      });
    }
  }
  flushPendingAssistantToolCalls();

  // Nettoyage séquentiel des blocs tool_calls incomplets
  // On traite les messages un par un : pour chaque assistant avec tool_calls,
  // on vérifie que les messages tool IMMÉDIATEMENT suivants couvrent tous les IDs.
  // Si incomplet → on supprime tout le bloc (assistant + tool partiels).
  // Les messages tool orphelins (sans assistant tool_calls précédent) sont aussi supprimés.
  const cleanedMessages: Json[] = [];
  let idx = 0;
  while (idx < messages.length) {
    const msg = messages[idx] as Json;

    if (
      msg.role === "assistant" &&
      Array.isArray(msg.tool_calls) &&
      (msg.tool_calls as Json[]).length > 0
    ) {
      // Collecter les IDs attendus
      const expectedIds = new Set<string>(
        (msg.tool_calls as Json[])
          .filter((tc) => typeof (tc as Json).id === "string")
          .map((tc) => (tc as Json).id as string)
      );

      // Collecter les messages tool qui suivent immédiatement
      let j = idx + 1;
      const followingToolMsgs: Json[] = [];
      const coveredIds = new Set<string>();
      while (j < messages.length && (messages[j] as Json).role === "tool") {
        const tm = messages[j] as Json;
        if (typeof tm.tool_call_id === "string") coveredIds.add(tm.tool_call_id);
        followingToolMsgs.push(tm);
        j++;
      }

      const allCovered = [...expectedIds].every((id) => coveredIds.has(id));
      if (allCovered) {
        // Bloc complet → garder assistant + tous les tool messages
        cleanedMessages.push(msg);
        for (const tm of followingToolMsgs) cleanedMessages.push(tm);
      } else {
        // Bloc incomplet → remplacer par un message texte neutre, ignorer les tool partials
        const names = (msg.tool_calls as Json[])
          .map((tc) => String(((tc as Json).function as Json)?.name ?? "tool"))
          .join(", ");
        cleanedMessages.push({ role: "assistant", content: `[${names}]` });
      }
      idx = j; // sauter assistant + tous les tool messages (complets ou non)
    } else if (msg.role === "tool") {
      // Message tool orphelin (pas précédé d'un assistant tool_calls) → supprimer
      idx++;
    } else {
      cleanedMessages.push(msg);
      idx++;
    }
  }
  const finalMessages = cleanedMessages;

  const tools = Array.isArray(body.tools) ? body.tools.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const tool = raw as Json;
    if (tool.type !== "function") return [];
    return [{
      type: "function",
      function: {
        name: String(tool.name ?? ""),
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: tool.parameters ?? { type: "object", properties: {} },
        strict: tool.strict === true
      }
    }];
  }) : [];
  const result: Json = {
    model,
    messages: finalMessages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? (body.tool_choice ?? "auto") : undefined,
    parallel_tool_calls: body.parallel_tool_calls,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined
  };
  if (model.includes("deepseek") || model.includes("reasoner")) {
    // Désactiver le thinking mode côté proxy — évite tous les problèmes de reasoning_content
    // DeepSeek fonctionne parfaitement sans thinking; on supprime aussi tout reasoning_content injecté
    result.thinking = { type: "disabled" };
    for (const msg of finalMessages as Json[]) {
      delete (msg as Record<string, unknown>).reasoning_content;
    }
  }
  return result;
}

function providerHeaders(model: ResolvedModel, incoming: IncomingMessage): Headers {
  const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" });
  const key = model.provider.keyEnv ? process.env[model.provider.keyEnv] : undefined;
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (
    model.provider.forwardAuthorization &&
    model.provider.protocol === "responses" &&
    model.providerId.startsWith("openai") &&
    incoming.headers.authorization
  ) {
    headers.set("authorization", incoming.headers.authorization);
    for (const name of [
      "chatgpt-account-id",
      "originator",
      "openai-beta",
      "x-codex-turn-metadata",
      "x-codex-session-id",
      "x-codex-thread-id",
      "x-openai-internal-codex-responses-lite",
      "x-client-request-id"
    ]) {
      const value = incoming.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
  }
  return headers;
}

async function checkedFetch(url: URL, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Upstream redirects are refused: ${response.status}`);
  }
  return response;
}

function endpoint(baseURL: string, path: string): URL {
  return new URL(`${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}

async function upstreamError(response: Response): Promise<Error> {
  const text = (await response.text()).slice(0, 4096);
  return new Error(`Upstream ${response.status}: ${text || response.statusText}`);
}

export async function nativeResponses(
  req: IncomingMessage,
  res: ServerResponse,
  model: ResolvedModel,
  body: Json
): Promise<void> {
  if (!model.provider.baseURL) throw new Error(`Missing baseURL for ${model.providerId}`);
  const response = await checkedFetch(endpoint(model.provider.baseURL, "responses"), {
    method: "POST",
    headers: providerHeaders(model, req),
    body: JSON.stringify({ ...body, model: model.upstreamModel }),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw await upstreamError(response);
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  req.once("close", () => void reader.cancel());
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!res.write(chunk.value)) await new Promise<void>((resolve) => res.once("drain", resolve));
  }
  res.end();
}

function parseDataBlocks(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return { blocks: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

export async function chatResponses(
  req: IncomingMessage,
  res: ServerResponse,
  model: ResolvedModel,
  body: Json
): Promise<void> {
  if (!model.provider.baseURL) throw new Error(`Missing baseURL for ${model.providerId}`);
  if (model.provider.keyEnv && !process.env[model.provider.keyEnv]) {
    throw new Error(`Missing environment variable ${model.provider.keyEnv}`);
  }
  const chatReq = toChatRequest(body, model.upstreamModel);
  const response = await checkedFetch(endpoint(model.provider.baseURL, "chat/completions"), {
    method: "POST",
    headers: providerHeaders(model, req),
    body: JSON.stringify(chatReq),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw await upstreamError(response);
  if (!response.body) throw new Error("Upstream returned no body");

  return await processChatStream(req, res, response.body);
}

export async function processChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  stream: ReadableStream<Uint8Array>
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  event(res, { type: "response.created", response: { id: responseId } });

  let buffer = "";
  let text = "";
  let reasoningText = "";
  let textStarted = false;
  let usage: Json | undefined;
  const tools = new Map<number, { id: string; name: string; arguments: string; itemId: string; started: boolean }>();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  req.once("close", () => void reader.cancel());

  const consume = (block: string): void => {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const chunk = JSON.parse(data) as Json;
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage as Json;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] as Json | undefined;
    const delta = choice?.delta as Json | undefined;
    if (!delta) return;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoningText += delta.reasoning_content;
    }
    if (typeof delta.content === "string" && delta.content) {
      if (!textStarted) {
        textStarted = true;
        event(res, {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", role: "assistant", id: messageId, content: [] }
        });
      }
      text += delta.content;
      event(res, { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const part = raw as Json;
        const index = Number(part.index ?? 0);
        const fn = (part.function ?? {}) as Json;
        const current = tools.get(index) ?? {
          id: String(part.id ?? `call_${randomUUID()}`),
          name: "",
          arguments: "",
          itemId: `fc_${randomUUID()}`,
          started: false
        };
        if (typeof part.id === "string") current.id = part.id;
        if (typeof fn.name === "string") current.name += fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        if (!current.started) {
          current.started = true;
          event(res, {
            type: "response.output_item.added",
            output_index: index + 1,
            item: { type: "function_call", id: current.itemId, call_id: current.id, name: current.name, arguments: "" }
          });
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          event(res, {
            type: "response.function_call_arguments.delta",
            item_id: current.itemId,
            output_index: index + 1,
            delta: fn.arguments
          });
        }
        tools.set(index, current);
      }
    }
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseDataBlocks(buffer);
    buffer = parsed.rest;
    for (const block of parsed.blocks) consume(block);
  }
  if (buffer.trim()) consume(buffer);

  if (textStarted) {
    event(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", id: messageId, content: [{ type: "output_text", text }] }
    });
  }
  for (const [index, tool] of tools) {
    event(res, {
      type: "response.output_item.done",
      output_index: index + 1,
      item: {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.id,
        name: tool.name,
        arguments: tool.arguments
      }
    });
  }
  if (text && reasoningText) {
    addToReasoningCache(text, reasoningText);
  }
  event(res, { type: "response.completed", response: { id: responseId, usage: responseUsage(usage) } });
  res.end();
}

function toAnthropicRequest(body: Json, model: string, maxTokens: number): Json {
  const messages: Json[] = [];
  const input = Array.isArray(body.input) ? body.input : [{ type: "message", role: "user", content: body.input }];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Json;
    if (item.type === "message") {
      const role = item.role === "assistant" ? "assistant" : "user";
      const content = Array.isArray(item.content) ? item.content.flatMap((rawPart) => {
        if (!rawPart || typeof rawPart !== "object") return [];
        const part = rawPart as Json;
        if (["input_text", "output_text", "text"].includes(String(part.type))) {
          return [{ type: "text", text: String(part.text ?? "") }];
        }
        return [];
      }) : [{ type: "text", text: String(item.content ?? "") }];
      messages.push({ role, content });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [{
          type: "tool_use",
          id: String(item.call_id ?? item.id ?? randomUUID()),
          name: String(item.name ?? ""),
          input: JSON.parse(String(item.arguments ?? "{}"))
        }]
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: String(item.call_id ?? ""),
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null)
        }]
      });
    }
  }
  const tools = Array.isArray(body.tools) ? body.tools.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const tool = raw as Json;
    if (tool.type !== "function") return [];
    return [{
      name: String(tool.name ?? ""),
      description: typeof tool.description === "string" ? tool.description : undefined,
      input_schema: tool.parameters ?? { type: "object", properties: {} }
    }];
  }) : [];
  return {
    model,
    system: typeof body.instructions === "string" ? body.instructions : undefined,
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? { type: "auto" } : undefined,
    max_tokens: maxTokens,
    stream: true
  };
}

type AnthropicState = {
  text: string;
  textStarted: boolean;
  inputTokens: number;
  outputTokens: number;
  messageId: string;
};

export function consumeAnthropicEvent(
  chunk: Json,
  res: ServerResponse,
  tools: Map<number, { id: string; name: string; arguments: string; itemId: string }>,
  state: AnthropicState
): void {
  if (chunk.type === "message_start") {
    const message = (chunk.message ?? {}) as Json;
    const usage = (message.usage ?? {}) as Json;
    state.inputTokens = Number(usage.input_tokens ?? 0);
  }
  if (chunk.type === "message_delta") {
    const usage = (chunk.usage ?? {}) as Json;
    state.outputTokens = Number(usage.output_tokens ?? state.outputTokens);
  }
  if (chunk.type === "content_block_start") {
    const index = Number(chunk.index ?? 0);
    const content = (chunk.content_block ?? {}) as Json;
    if (content.type === "text") {
      if (!state.textStarted) {
        state.textStarted = true;
        event(res, {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", role: "assistant", id: state.messageId, content: [] }
        });
      }
      if (typeof content.text === "string" && content.text) {
        state.text += content.text;
        event(res, { type: "response.output_text.delta", item_id: state.messageId, output_index: 0, content_index: 0, delta: content.text });
      }
    } else if (content.type === "tool_use") {
      const item = {
        id: String(content.id ?? `call_${randomUUID()}`),
        name: String(content.name ?? ""),
        arguments: content.input ? JSON.stringify(content.input) : "",
        itemId: `fc_${randomUUID()}`
      };
      tools.set(index, item);
      event(res, {
        type: "response.output_item.added",
        output_index: index + 1,
        item: { type: "function_call", id: item.itemId, call_id: item.id, name: item.name, arguments: "" }
      });
    }
  }
  if (chunk.type === "content_block_delta") {
    const index = Number(chunk.index ?? 0);
    const delta = (chunk.delta ?? {}) as Json;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      state.text += delta.text;
      event(res, { type: "response.output_text.delta", item_id: state.messageId, output_index: 0, content_index: 0, delta: delta.text });
    } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const tool = tools.get(index);
      if (!tool) return;
      tool.arguments += delta.partial_json;
      event(res, {
        type: "response.function_call_arguments.delta",
        item_id: tool.itemId,
        output_index: index + 1,
        delta: delta.partial_json
      });
    }
  }
}

export async function anthropicResponses(
  req: IncomingMessage,
  res: ServerResponse,
  model: ResolvedModel,
  body: Json
): Promise<void> {
  if (!model.provider.baseURL) throw new Error(`Missing baseURL for ${model.providerId}`);
  if (!model.provider.keyEnv || !process.env[model.provider.keyEnv]) {
    throw new Error(`Missing environment variable ${model.provider.keyEnv ?? "(provider key)"}`);
  }
  const response = await checkedFetch(endpoint(model.provider.baseURL, "messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": process.env[model.provider.keyEnv] ?? "",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(toAnthropicRequest(body, model.upstreamModel, model.metadata.output ?? 8192)),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw await upstreamError(response);
  if (!response.body) throw new Error("Upstream returned no body");

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  event(res, { type: "response.created", response: { id: responseId } });

  let buffer = "";
  const tools = new Map<number, { id: string; name: string; arguments: string; itemId: string }>();
  const state: AnthropicState = {
    text: "",
    textStarted: false,
    inputTokens: 0,
    outputTokens: 0,
    messageId
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  req.once("close", () => void reader.cancel());

  const consume = (block: string): void => {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    const chunk = JSON.parse(data) as Json;
    consumeAnthropicEvent(chunk, res, tools, state);
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseDataBlocks(buffer);
    buffer = parsed.rest;
    for (const block of parsed.blocks) consume(block);
  }
  if (buffer.trim()) consume(buffer);

  if (state.textStarted) {
    event(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", id: messageId, content: [{ type: "output_text", text: state.text }] }
    });
  }
  for (const [index, tool] of tools) {
    event(res, {
      type: "response.output_item.done",
      output_index: index + 1,
      item: {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.id,
        name: tool.name,
        arguments: tool.arguments || "{}"
      }
    });
  }
  event(res, {
    type: "response.completed",
    response: {
      id: responseId,
      usage: responseUsage({ input_tokens: state.inputTokens, output_tokens: state.outputTokens })
    }
  });
  res.end();
}

function toGoogleRequest(body: Json, maxTokens: number): Json {
  const callNames = new Map<string, string>();
  const input = Array.isArray(body.input) ? body.input : [{ type: "message", role: "user", content: body.input }];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Json;
    if (item.type === "function_call") {
      callNames.set(String(item.call_id ?? item.id ?? ""), String(item.name ?? ""));
    }
  }
  const contents: Json[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Json;
    if (item.type === "message") {
      const parts = Array.isArray(item.content) ? item.content.flatMap((rawPart) => {
        if (!rawPart || typeof rawPart !== "object") return [];
        const part = rawPart as Json;
        if (["input_text", "output_text", "text"].includes(String(part.type))) {
          return [{ text: String(part.text ?? "") }];
        }
        return [];
      }) : [{ text: String(item.content ?? "") }];
      contents.push({ role: item.role === "assistant" ? "model" : "user", parts });
    } else if (item.type === "function_call") {
      contents.push({
        role: "model",
        parts: [{
          functionCall: {
            name: String(item.name ?? ""),
            args: JSON.parse(String(item.arguments ?? "{}"))
          }
        }]
      });
    } else if (item.type === "function_call_output") {
      const callId = String(item.call_id ?? "");
      const output = typeof item.output === "string" ? { output: item.output } : item.output;
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: callNames.get(callId) ?? "tool",
            response: output && typeof output === "object" ? output : { output }
          }
        }]
      });
    }
  }
  const declarations = Array.isArray(body.tools) ? body.tools.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const tool = raw as Json;
    if (tool.type !== "function") return [];
    return [{
      name: String(tool.name ?? ""),
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: tool.parameters ?? { type: "object", properties: {} }
    }];
  }) : [];
  return {
    systemInstruction: typeof body.instructions === "string"
      ? { parts: [{ text: body.instructions }] }
      : undefined,
    contents,
    tools: declarations.length ? [{ functionDeclarations: declarations }] : undefined,
    toolConfig: declarations.length ? { functionCallingConfig: { mode: "AUTO" } } : undefined,
    generationConfig: { maxOutputTokens: maxTokens }
  };
}

export async function googleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  model: ResolvedModel,
  body: Json
): Promise<void> {
  if (!model.provider.baseURL) throw new Error(`Missing baseURL for ${model.providerId}`);
  if (!model.provider.keyEnv || !process.env[model.provider.keyEnv]) {
    throw new Error(`Missing environment variable ${model.provider.keyEnv ?? "(provider key)"}`);
  }
  const url = endpoint(
    model.provider.baseURL,
    `models/${encodeURIComponent(model.upstreamModel)}:streamGenerateContent?alt=sse`
  );
  const response = await checkedFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-goog-api-key": process.env[model.provider.keyEnv] ?? ""
    },
    body: JSON.stringify(toGoogleRequest(body, model.metadata.output ?? 8192)),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw await upstreamError(response);
  if (!response.body) throw new Error("Upstream returned no body");

  return await processGoogleStream(req, res, response.body);
}

export async function processGoogleStream(
  req: IncomingMessage,
  res: ServerResponse,
  stream: ReadableStream<Uint8Array>
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  event(res, { type: "response.created", response: { id: responseId } });

  let buffer = "";
  let text = "";
  let textStarted = false;
  let usage: Json | undefined;
  let toolIndex = 0;
  const completedTools: Array<{ id: string; name: string; arguments: string; itemId: string }> = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  req.once("close", () => void reader.cancel());

  const consume = (block: string): void => {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    const chunk = JSON.parse(data) as Json;
    if (chunk.usageMetadata && typeof chunk.usageMetadata === "object") {
      const source = chunk.usageMetadata as Json;
      usage = {
        input_tokens: source.promptTokenCount,
        output_tokens: source.candidatesTokenCount,
        total_tokens: source.totalTokenCount
      };
    }
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
    const candidate = candidates[0] as Json | undefined;
    const content = candidate?.content as Json | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const rawPart of parts) {
      const part = rawPart as Json;
      if (typeof part.text === "string" && part.text) {
        if (!textStarted) {
          textStarted = true;
          event(res, {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", role: "assistant", id: messageId, content: [] }
          });
        }
        text += part.text;
        event(res, { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: part.text });
      }
      if (part.functionCall && typeof part.functionCall === "object") {
        const fn = part.functionCall as Json;
        const tool = {
          id: `call_${randomUUID()}`,
          itemId: `fc_${randomUUID()}`,
          name: String(fn.name ?? ""),
          arguments: JSON.stringify(fn.args ?? {})
        };
        event(res, {
          type: "response.output_item.added",
          output_index: toolIndex + 1,
          item: { type: "function_call", id: tool.itemId, call_id: tool.id, name: tool.name, arguments: "" }
        });
        completedTools.push(tool);
        toolIndex += 1;
      }
    }
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const parsed = parseDataBlocks(buffer);
    buffer = parsed.rest;
    for (const block of parsed.blocks) consume(block);
  }
  if (buffer.trim()) consume(buffer);

  if (textStarted) {
    event(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", id: messageId, content: [{ type: "output_text", text }] }
    });
  }
  completedTools.forEach((tool, index) => {
    event(res, {
      type: "response.output_item.done",
      output_index: index + 1,
      item: {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.id,
        name: tool.name,
        arguments: tool.arguments
      }
    });
  });
  event(res, { type: "response.completed", response: { id: responseId, usage: responseUsage(usage) } });
  res.end();
}

async function getVertexAccessToken(): Promise<string> {
  if (process.env.GOOGLE_VERTEX_ACCESS_TOKEN) {
    return process.env.GOOGLE_VERTEX_ACCESS_TOKEN;
  }
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (serviceAccountPath && existsSync(serviceAccountPath)) {
    try {
      const sa = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
      const clientEmail = sa.client_email;
      const privateKey = sa.private_key;
      if (clientEmail && privateKey) {
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
        const now = Math.floor(Date.now() / 1000);
        const payload = Buffer.from(JSON.stringify({
          iss: clientEmail,
          scope: "https://www.googleapis.com/auth/cloud-platform",
          aud: "https://oauth2.googleapis.com/token",
          exp: now + 3600,
          iat: now
        })).toString("base64url");
        
        const sign = createSign("RSA-SHA256");
        sign.update(`${header}.${payload}`);
        const signature = sign.sign(privateKey, "base64url");
        const jwt = `${header}.${payload}.${signature}`;
        
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: jwt
          })
        });
        if (tokenRes.ok) {
          const data = await tokenRes.json() as { access_token: string };
          return data.access_token;
        } else {
          throw new Error(`Failed to exchange JWT for token: ${await tokenRes.text()}`);
        }
      }
    } catch (e) {
      console.warn("Could not sign JWT using GOOGLE_APPLICATION_CREDENTIALS, trying fallback:", e);
    }
  }

  try {
    const { spawnSync } = await import("node:child_process");
    const gcloud = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "gcloud auth print-access-token"], { encoding: "utf8" })
      : spawnSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" });
    const token = gcloud.stdout?.trim();
    if (token) return token;
  } catch (e) {
    // ignore
  }

  throw new Error("No Google Vertex access token found. Please set GOOGLE_VERTEX_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS.");
}

export async function googleVertexResponses(
  req: IncomingMessage,
  res: ServerResponse,
  model: ResolvedModel,
  body: Json
): Promise<void> {
  const project = process.env.GOOGLE_VERTEX_PROJECT;
  const location = process.env.GOOGLE_VERTEX_LOCATION ?? "us-central1";
  if (!project) throw new Error("Missing GOOGLE_VERTEX_PROJECT environment variable");

  const token = await getVertexAccessToken();
  const base = model.provider.baseURL ?? `https://${location}-aiplatform.googleapis.com`;
  const url = new URL(`${base.replace(/\/+$/, "")}/v1/projects/${project}/locations/${location}/publishers/google/models/${model.upstreamModel}:streamGenerateContent?alt=sse`);

  const response = await checkedFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(toGoogleRequest(body, model.metadata.output ?? 8192)),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw await upstreamError(response);
  if (!response.body) throw new Error("Upstream returned no body");

  return await processGoogleStream(req, res, response.body);
}

export async function azureResponses(
  req: IncomingMessage,
  res: ServerResponse,
  model: ResolvedModel,
  body: Json
): Promise<void> {
  let baseURL = model.provider.baseURL;
  if (!baseURL) {
    const resource = process.env.AZURE_RESOURCE_NAME ?? process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME;
    if (!resource) throw new Error("Missing AZURE_RESOURCE_NAME or AZURE_COGNITIVE_SERVICES_RESOURCE_NAME env");
    baseURL = `https://${resource}.openai.azure.com`;
  }
  const apiVersion = "2024-06-01";
  const url = new URL(`${baseURL.replace(/\/+$/, "")}/openai/deployments/${model.upstreamModel}/chat/completions?api-version=${apiVersion}`);

  const key = model.provider.keyEnv ? process.env[model.provider.keyEnv] : undefined;
  const actualKey = key ?? process.env.AZURE_API_KEY ?? process.env.AZURE_COGNITIVE_SERVICES_API_KEY;
  if (!actualKey) throw new Error("Missing Azure API key");

  const response = await checkedFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "api-key": actualKey
    },
    body: JSON.stringify(toChatRequest(body, model.upstreamModel)),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw await upstreamError(response);
  if (!response.body) throw new Error("Upstream returned no body");

  return await processChatStream(req, res, response.body);
}

function signAwsRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string,
  service: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string
): Record<string, string> {
  const datetime = new Date().toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
  const date = datetime.slice(0, 8);

  const canonicalHeaders: string[] = [];
  const signedHeaders: string[] = [];

  const host = url.host;
  const allHeaders: Record<string, string> = {
    host,
    "x-amz-date": datetime,
    ...headers
  };
  if (sessionToken) {
    allHeaders["x-amz-security-token"] = sessionToken;
  }

  for (const key of Object.keys(allHeaders).sort()) {
    canonicalHeaders.push(`${key.toLowerCase()}:${allHeaders[key].trim()}`);
    signedHeaders.push(key.toLowerCase());
  }

  const payloadHash = createHash("sha256").update(body).digest("hex");
  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders.join("\n") + "\n",
    signedHeaders.join(";"),
    payloadHash
  ].join("\n");

  const credentialScope = [date, region, service, "aws4_request"].join("/");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");

  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`).update(date).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  allHeaders["Authorization"] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;

  return allHeaders;
}

function parseEventStream(stream: ReadableStream<Uint8Array>, onPayload: (payload: string) => void): Promise<void> {
  const reader = stream.getReader();
  let buffer = Buffer.alloc(0);

  return new Promise(async (resolve, reject) => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = Buffer.concat([buffer, value]);

        while (buffer.length >= 12) {
          const totalLength = buffer.readUInt32BE(0);
          const headersLength = buffer.readUInt32BE(4);
          if (buffer.length < totalLength) {
            break;
          }
          const message = buffer.subarray(0, totalLength);
          buffer = buffer.subarray(totalLength);

          const payloadLength = totalLength - headersLength - 16;
          if (payloadLength > 0) {
            const payload = message.subarray(12 + headersLength, totalLength - 4);
            onPayload(payload.toString("utf8"));
          }
        }
      }
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

export async function bedrockResponses(
  req: IncomingMessage,
  res: ServerResponse,
  model: ResolvedModel,
  body: Json
): Promise<void> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;

  const base = model.provider.baseURL ?? `https://bedrock-runtime.${region}.amazonaws.com`;
  const url = new URL(`${base.replace(/\/+$/, "")}/model/${encodeURIComponent(model.upstreamModel)}/invoke-with-response-stream`);

  const anthropicPayload = toAnthropicRequest(body, model.upstreamModel, model.metadata.output ?? 8192);
  const { model: _, ...bedrockPayload } = anthropicPayload;
  const finalBody = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    ...bedrockPayload
  });

  let headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json"
  };

  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  } else {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("Missing AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)");
    }
    headers = signAwsRequest(
      url,
      "POST",
      headers,
      finalBody,
      "bedrock",
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken
    );
  }

  const response = await checkedFetch(url, {
    method: "POST",
    headers,
    body: finalBody,
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw await upstreamError(response);
  if (!response.body) throw new Error("Upstream returned no body");

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  event(res, { type: "response.created", response: { id: responseId } });

  const state: AnthropicState = {
    text: "",
    textStarted: false,
    inputTokens: 0,
    outputTokens: 0,
    messageId
  };
  const tools = new Map<number, { id: string; name: string; arguments: string; itemId: string }>();

  await parseEventStream(response.body, (payloadStr) => {
    try {
      const outer = JSON.parse(payloadStr);
      const bytesB64 = outer.chunk?.bytes;
      if (!bytesB64) return;
      const innerJson = JSON.parse(Buffer.from(bytesB64, "base64").toString("utf8"));
      consumeAnthropicEvent(innerJson, res, tools, state);
    } catch (err) {
      console.error("Failed to parse Bedrock payload:", err);
    }
  });

  if (state.textStarted) {
    event(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", id: messageId, content: [{ type: "output_text", text: state.text }] }
    });
  }
  for (const [index, tool] of tools) {
    event(res, {
      type: "response.output_item.done",
      output_index: index + 1,
      item: {
        type: "function_call",
        id: tool.itemId,
        call_id: tool.id,
        name: tool.name,
        arguments: tool.arguments || "{}"
      }
    });
  }
  event(res, {
    type: "response.completed",
    response: {
      id: responseId,
      usage: responseUsage({ input_tokens: state.inputTokens, output_tokens: state.outputTokens })
    }
  });
  res.end();
}

export function mockResponses(res: ServerResponse, model: ResolvedModel, body: Json): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const responseId = `resp_${randomUUID()}`;
  event(res, { type: "response.created", response: { id: responseId } });
  const tools = Array.isArray(body.tools) ? body.tools as Json[] : [];
  const inputText = outputText(body.input).toLowerCase();
  const input = Array.isArray(body.input) ? body.input as Json[] : [];
  const hasToolResult = input.some((item) => item.type === "function_call_output");
  if (model.upstreamModel === "tool" && tools.length && inputText.includes("tool") && !hasToolResult) {
    const tool = tools.find((item) => {
      const name = String(item.name ?? "");
      return item.type === "function" && (name.includes("exec_command") || name.includes("shell_command"));
    }) ?? tools.find((item) => item.type === "function") ?? tools[0];
    const name = String(tool?.name ?? "shell_command");
    const parameters = (tool?.parameters ?? {}) as Json;
    const properties = (parameters.properties ?? {}) as Json;
    const argumentsValue = "cmd" in properties
      ? { cmd: "Write-Output OMNICODEX_TOOL_OK" }
      : { command: "Write-Output OMNICODEX_TOOL_OK" };
    event(res, {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: `fc_${randomUUID()}`,
        call_id: `call_${randomUUID()}`,
        name,
        arguments: JSON.stringify(argumentsValue)
      }
    });
  } else {
    const id = `msg_${randomUUID()}`;
    const text = hasToolResult ? "OMNICODEX_TOOL_OK" : "OMNICODEX_OK";
    event(res, {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant", id, content: [] }
    });
    event(res, { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text });
    event(res, {
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] }
    });
  }
  event(res, { type: "response.completed", response: { id: responseId, usage: responseUsage(undefined) } });
  res.end();
}
