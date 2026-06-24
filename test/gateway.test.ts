import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { GatewayConfig } from "../src/config.ts";
import { createGatewayServer } from "../src/server.ts";
import { toChatRequest } from "../src/responses.ts";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

test("converts Codex Responses messages and tools to chat completions", () => {
  const result = toChatRequest({
    instructions: "system",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "developer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }
    ],
    tools: [{ type: "function", name: "shell_command", parameters: { type: "object" } }]
  }, "deepseek-chat");
  assert.equal(result.model, "deepseek-chat");
  assert.equal((result.messages as any[])[1].role, "system");
  assert.equal((result.messages as any[])[2].content, "hello");
  assert.equal((result.tools as any[])[0].function.name, "shell_command");
});

test("serves a Codex-compatible mock Responses stream", async (t) => {
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    providers: { mock: { protocol: "mock", models: { echo: { tools: true } } } }
  };
  const server = createGatewayServer(config);
  t.after(() => server.close());
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/echo", input: "hello", stream: true })
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /response\.output_item\.done/);
  assert.match(text, /OMNICODEX_OK/);
  assert.match(text, /response\.completed/);
});

test("never forwards inbound OpenAI bearer to a DeepSeek-style provider", async (t) => {
  let authorization = "";
  const upstream = createServer(async (req, res) => {
    authorization = String(req.headers.authorization ?? "");
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
      "data: [DONE]",
      ""
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);
  process.env.TEST_PROVIDER_KEY = "provider-secret";
  t.after(() => delete process.env.TEST_PROVIDER_KEY);

  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    providers: {
      deepseek: {
        protocol: "openai-compatible",
        baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
        keyEnv: "TEST_PROVIDER_KEY",
        models: { chat: {} }
      }
    }
  };
  const gateway = createGatewayServer(config);
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-secret" },
    body: JSON.stringify({ model: "deepseek/chat", input: "hello", stream: true })
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.completed/);
  assert.equal(authorization, "Bearer provider-secret");
});

test("forwards OAuth headers only for an explicit OpenAI Responses route", async (t) => {
  let authorization = "";
  let account = "";
  const upstream = createServer(async (req, res) => {
    authorization = String(req.headers.authorization ?? "");
    account = String(req.headers["chatgpt-account-id"] ?? "");
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "oauth-ok" }] }
      })}`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
      })}`,
      ""
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    providers: {
      "openai-chatgpt": {
        protocol: "responses",
        baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
        forwardAuthorization: true,
        models: { test: {} }
      }
    }
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oauth-secret",
      "chatgpt-account-id": "account-1"
    },
    body: JSON.stringify({ model: "openai-chatgpt/test", input: "hello", stream: true })
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /oauth-ok/);
  assert.equal(authorization, "Bearer oauth-secret");
  assert.equal(account, "account-1");
});

test("translates Anthropic Messages streaming without forwarding inbound bearer", async (t) => {
  let apiKey = "";
  let authorization = "";
  const upstream = createServer(async (req, res) => {
    apiKey = String(req.headers["x-api-key"] ?? "");
    authorization = String(req.headers.authorization ?? "");
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 2 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "anthropic-ok" } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      ""
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);
  process.env.TEST_ANTHROPIC_KEY = "anthropic-secret";
  t.after(() => delete process.env.TEST_ANTHROPIC_KEY);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    providers: {
      anthropic: {
        protocol: "anthropic",
        baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
        keyEnv: "TEST_ANTHROPIC_KEY",
        models: { sonnet: { output: 4096 } }
      }
    }
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-secret" },
    body: JSON.stringify({ model: "anthropic/sonnet", input: "hello", stream: true })
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /anthropic-ok/);
  assert.match(text, /response\.completed/);
  assert.equal(apiKey, "anthropic-secret");
  assert.equal(authorization, "");
});

test("translates Google Gemini streaming and isolates its API key", async (t) => {
  let apiKey = "";
  let authorization = "";
  const upstream = createServer(async (req, res) => {
    apiKey = String(req.headers["x-goog-api-key"] ?? "");
    authorization = String(req.headers.authorization ?? "");
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "gemini-ok" }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }
      })}`,
      ""
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);
  process.env.TEST_GOOGLE_KEY = "google-secret";
  t.after(() => delete process.env.TEST_GOOGLE_KEY);
  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    providers: {
      google: {
        protocol: "google",
        baseURL: `http://127.0.0.1:${upstreamPort}/v1beta`,
        keyEnv: "TEST_GOOGLE_KEY",
        models: { flash: { output: 4096 } }
      }
    }
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer oauth-secret" },
    body: JSON.stringify({ model: "google/flash", input: "hello", stream: true })
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /gemini-ok/);
  assert.match(text, /response\.completed/);
  assert.equal(apiKey, "google-secret");
  assert.equal(authorization, "");
});

test("translates Azure OpenAI chat completions streaming", async (t) => {
  let apiKey = "";
  const upstream = createServer(async (req, res) => {
    apiKey = String(req.headers["api-key"] ?? "");
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "azure-ok" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}`,
      "data: [DONE]",
      ""
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);
  
  process.env.TEST_AZURE_KEY = "azure-secret";
  t.after(() => delete process.env.TEST_AZURE_KEY);

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    providers: {
      azure: {
        protocol: "azure",
        baseURL: `http://127.0.0.1:${upstreamPort}`,
        keyEnv: "TEST_AZURE_KEY",
        models: { "gpt-4o": {} }
      }
    }
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "azure/gpt-4o", input: "hello", stream: true })
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /azure-ok/);
  assert.match(text, /response\.completed/);
  assert.equal(apiKey, "azure-secret");
});

test("translates Google Vertex streaming and handles token mapping", async (t) => {
  let auth = "";
  const upstream = createServer(async (req, res) => {
    auth = String(req.headers.authorization ?? "");
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "vertex-ok" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 15, totalTokenCount: 20 }
      })}`,
      ""
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);

  process.env.GOOGLE_VERTEX_PROJECT = "my-project";
  process.env.GOOGLE_VERTEX_LOCATION = "us-east1";
  process.env.GOOGLE_VERTEX_ACCESS_TOKEN = "vertex-token";
  t.after(() => {
    delete process.env.GOOGLE_VERTEX_PROJECT;
    delete process.env.GOOGLE_VERTEX_LOCATION;
    delete process.env.GOOGLE_VERTEX_ACCESS_TOKEN;
  });

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    providers: {
      "google-vertex": {
        protocol: "google-vertex",
        baseURL: `http://127.0.0.1:${upstreamPort}`,
        models: { "gemini-1.5": {} }
      }
    }
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "google-vertex/gemini-1.5", input: "hello", stream: true })
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /vertex-ok/);
  assert.match(text, /response\.completed/);
  assert.equal(auth, "Bearer vertex-token");
});

test("translates AWS Bedrock InvokeModelWithResponseStream streaming", async (t) => {
  let authHeader = "";
  const upstream = createServer(async (req, res) => {
    authHeader = String(req.headers.authorization ?? "");
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    
    const inner = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "bedrock-ok" } });
    const base64 = Buffer.from(inner).toString("base64");
    const payloadStr = JSON.stringify({ chunk: { bytes: base64 } });
    
    const payloadBuf = Buffer.from(payloadStr, "utf8");
    const totalLength = 12 + payloadBuf.length + 4;
    const message = Buffer.alloc(totalLength);
    message.writeUInt32BE(totalLength, 0);
    message.writeUInt32BE(0, 4); // headers length
    message.writeUInt32BE(0, 8); // dummy CRC
    payloadBuf.copy(message, 12);
    message.writeUInt32BE(0, totalLength - 4); // dummy CRC
    
    res.end(message);
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);

  process.env.AWS_REGION = "us-west-2";
  process.env.AWS_ACCESS_KEY_ID = "mock-key";
  process.env.AWS_SECRET_ACCESS_KEY = "mock-secret";
  t.after(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    providers: {
      "amazon-bedrock": {
        protocol: "bedrock",
        baseURL: `http://127.0.0.1:${upstreamPort}`,
        models: { "claude-3-5": {} }
      }
    }
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "amazon-bedrock/claude-3-5", input: "hello", stream: true })
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /bedrock-ok/);
  assert.match(text, /response\.completed/);
  assert.match(authHeader, /AWS4-HMAC-SHA256/);
});

test("handles DeepSeek reasoning_content caching and injection", async (t) => {
  let requestPayload: any = null;
  const upstream = createServer(async (req, res) => {
    let bodyStr = "";
    for await (const chunk of req) {
      bodyStr += chunk.toString("utf8");
    }
    requestPayload = JSON.parse(bodyStr);
    res.writeHead(200, { "content-type": "text/event-stream" });
    
    const lastMsg = requestPayload.messages[requestPayload.messages.length - 1];
    let outputText = "next-turn-response";
    if (requestPayload.thinking?.type === "disabled") {
      outputText = "thinking-disabled-response";
    }
    
    res.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: outputText, reasoning_content: "internal-thoughts" } }] })}`,
      "data: [DONE]",
      ""
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);

  process.env.TEST_DEEPSEEK_KEY = "deepseek-secret";
  t.after(() => delete process.env.TEST_DEEPSEEK_KEY);

  const gateway = createGatewayServer({
    host: "127.0.0.1",
    port: 0,
    providers: {
      deepseek: {
        protocol: "openai-compatible",
        baseURL: `http://127.0.0.1:${upstreamPort}`,
        keyEnv: "TEST_DEEPSEEK_KEY",
        models: { "deepseek-v4-flash": {} }
      }
    }
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);

  // Turn 1
  const res1 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello", stream: true })
  });
  const text1 = await res1.text();
  assert.match(text1, /next-turn-response/);

  // Turn 2 (Cache Hit)
  const res2 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", content: "next-turn-response" },
        { type: "message", role: "user", content: "how are you?" }
      ],
      stream: true
    })
  });
  await res2.text();
  assert.equal(requestPayload.messages[1].role, "assistant");
  assert.equal(requestPayload.messages[1].reasoning_content, "internal-thoughts");
  assert.equal(requestPayload.thinking, undefined);

  // Turn 3 (Cache Miss / Fallback)
  const res3 = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "message", role: "assistant", content: "unknown-assistant-msg" },
        { type: "message", role: "user", content: "how are you?" }
      ],
      stream: true
    })
  });
  const text3 = await res3.text();
  assert.match(text3, /next-turn-response/);
  assert.equal(requestPayload.messages[1].reasoning_content, "Thinking...");
  assert.equal(requestPayload.thinking, undefined);
});

test("rejects ambiguous model ids", async (t) => {
  const server = createGatewayServer({ host: "127.0.0.1", port: 0, providers: {} });
  t.after(() => server.close());
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "echo", input: "hello" })
  });
  assert.equal(response.status, 400);
});
