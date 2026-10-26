import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../src/server.ts";
import { anthropicToResponsesBody, parseResponsesSSE } from "../src/messages.ts";
import { listConversations, readConversation } from "../src/sessions.ts";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

const mockConfig = () => ({
  host: "127.0.0.1", port: 0,
  providers: { mock: { protocol: "mock" as const, models: { echo: { tools: true }, tool: { tools: true } } } },
});

test("/v1/messages (Claude Code) returns a non-streaming Anthropic message", async (t) => {
  const gateway = createGatewayServer(mockConfig());
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/echo", messages: [{ role: "user", content: "hello" }], max_tokens: 100 }),
  });
  assert.equal(res.status, 200);
  const data = await res.json() as any;
  assert.equal(data.type, "message");
  assert.equal(data.role, "assistant");
  assert.equal(data.content[0].type, "text");
  assert.match(data.content[0].text, /OMNICODEX_OK/);
  assert.equal(data.stop_reason, "end_turn");
});

test("/v1/messages streams Anthropic SSE when stream=true", async (t) => {
  const gateway = createGatewayServer(mockConfig());
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/echo", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /content_block_delta/);
  assert.match(text, /OMNICODEX_OK/);
  assert.match(text, /event: message_stop/);
});

test("/v1/messages surfaces tool_use for tool-calling models", async (t) => {
  const gateway = createGatewayServer(mockConfig());
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock/tool",
      messages: [{ role: "user", content: "please use a tool" }],
      tools: [{ name: "shell_command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
      max_tokens: 100,
    }),
  });
  const data = await res.json() as any;
  const toolUse = data.content.find((c: any) => c.type === "tool_use");
  assert.ok(toolUse, "expected a tool_use block");
  assert.equal(toolUse.name, "shell_command");
  assert.equal(data.stop_reason, "tool_use");
});

test("anthropicToResponsesBody maps system, tool_use and tool_result", () => {
  const out = anthropicToResponsesBody({
    model: "x/y",
    system: "be terse",
    messages: [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "sh", input: { cmd: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
    tools: [{ name: "sh", input_schema: { type: "object" } }],
    max_tokens: 64,
  });
  assert.equal(out.instructions, "be terse");
  assert.equal((out.max_output_tokens as number), 64);
  const input = out.input as any[];
  assert.equal(input[0].type, "message");
  assert.equal(input[1].type, "function_call");
  assert.equal(input[1].name, "sh");
  assert.equal(input[2].type, "function_call_output");
  assert.equal((out.tools as any[])[0].name, "sh");
});

test("parseResponsesSSE extracts text, tools and usage", () => {
  const sse = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "c1", name: "sh", arguments: "{}" } })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } })}`,
    "",
  ].join("\n\n");
  const p = parseResponsesSSE(sse);
  assert.equal(p.text, "Hello");
  assert.equal(p.tools.length, 1);
  assert.equal(p.tools[0].name, "sh");
  assert.equal((p.usage as any).output_tokens, 2);
});

test("conversation history is parsed from rollout JSONL across profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-sess-"));
  mkdirSync(join(dir, "2026", "07", "01"), { recursive: true });
  writeFileSync(join(dir, "2026", "07", "01", "rollout-2026-07-01T10-00-00-abc.jsonl"), [
    JSON.stringify({ timestamp: "2026-07-01T10:00:00Z", type: "session_meta", payload: { model: "deepseek/deepseek-v4-pro", cwd: "/p" } }),
    JSON.stringify({ type: "message", payload: { role: "user", content: [{ type: "input_text", text: "fix my bug" }] } }),
    JSON.stringify({ type: "message", payload: { role: "assistant", content: [{ type: "output_text", text: "done" }] } }),
  ].join("\n"));
  process.env.OMNICODEX_SESSIONS_DIR = dir;
  try {
    const list = listConversations();
    assert.equal(list.length, 1);
    assert.equal(list[0].model, "deepseek/deepseek-v4-pro");
    assert.equal(list[0].provider, "deepseek");
    assert.equal(list[0].turns, 2);
    assert.match(list[0].preview, /fix my bug/);
    const conv = readConversation(list[0].id);
    assert.equal(conv?.turns[1].role, "assistant");
  } finally {
    delete process.env.OMNICODEX_SESSIONS_DIR;
  }
});

import { createAdminServer } from "../src/admin.ts";

async function adminReq(port: number, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

test("admin persists provider create / list / delete and disables built-ins", async (t) => {
  const cfgFile = join(mkdtempSync(join(tmpdir(), "omni-cfg-")), "omnicodex.config.json");
  writeFileSync(cfgFile, "{}");
  const prev = process.env.OMNICODEX_CONFIG;
  process.env.OMNICODEX_CONFIG = cfgFile;
  const admin = createAdminServer({ host: "127.0.0.1", port: 0, providers: {} });
  t.after(() => { admin.close(); if (prev === undefined) delete process.env.OMNICODEX_CONFIG; else process.env.OMNICODEX_CONFIG = prev; });
  const port = await listen(admin);

  // create
  const created = await adminReq(port, "POST", "/api/providers", { id: "acme", name: "Acme", protocol: "openai-compatible", baseURL: "https://api.acme.ai/v1" });
  assert.equal(created.ok, true);
  // list shows it
  let list = await adminReq(port, "GET", "/api/providers");
  const acme = list.find((p: any) => p.id === "acme");
  assert.ok(acme, "acme present");
  assert.equal(acme.baseURL, "https://api.acme.ai/v1");
  assert.equal(acme.enabled, true);
  assert.equal(acme.builtin, false);
  // update (edit baseURL)
  await adminReq(port, "POST", "/api/providers", { id: "acme", baseURL: "https://api.acme.ai/v2" });
  list = await adminReq(port, "GET", "/api/providers");
  assert.equal(list.find((p: any) => p.id === "acme").baseURL, "https://api.acme.ai/v2");
  // delete removes non-builtin
  await adminReq(port, "DELETE", "/api/providers/acme");
  list = await adminReq(port, "GET", "/api/providers");
  assert.equal(list.find((p: any) => p.id === "acme"), undefined);
  // delete of a built-in only disables it
  await adminReq(port, "DELETE", "/api/providers/deepseek");
  list = await adminReq(port, "GET", "/api/providers");
  const ds = list.find((p: any) => p.id === "deepseek");
  assert.ok(ds, "deepseek still listed");
  assert.equal(ds.enabled, false);
});

test("/v1/messages streams incrementally (one text_delta per upstream chunk)", async (t) => {
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) void _;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  t.after(() => upstream.close());
  const upstreamPort = await listen(upstream);
  process.env.TEST_STREAM_KEY = "sk-test";
  t.after(() => delete process.env.TEST_STREAM_KEY);
  const gateway = createGatewayServer({
    host: "127.0.0.1", port: 0,
    providers: { prov: { protocol: "openai-compatible", baseURL: `http://127.0.0.1:${upstreamPort}`, keyEnv: "TEST_STREAM_KEY", models: { chat: {} } } },
  });
  t.after(() => gateway.close());
  const port = await listen(gateway);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "prov/chat", messages: [{ role: "user", content: "hi" }], max_tokens: 50, stream: true }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const deltas = [...text.matchAll(/"type":"text_delta","text":"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.match(text, /event: content_block_start/);
  assert.match(text, /event: message_delta/);
  assert.match(text, /event: message_stop/);
});

import { runDeviceFlow } from "../src/oauth.ts";

test("OAuth device flow: authorizes after polling through authorization_pending", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string, init: any) => {
    calls.push(url + "|" + init.body);
    if (url.endsWith("/device")) {
      return { ok: true, status: 200, json: async () => ({ device_code: "DC", user_code: "WXYZ-1234", verification_uri: "https://ex/activate", interval: 1, expires_in: 60 }), text: async () => "" };
    }
    // token endpoint: first pending, then success
    const attempt = calls.filter((c) => c.startsWith("https://ex/token")).length;
    if (attempt === 1) return { ok: true, status: 200, json: async () => ({ error: "authorization_pending" }), text: async () => "" };
    return { ok: true, status: 200, json: async () => ({ access_token: "tok-123" }), text: async () => "" };
  };
  let prompted = "";
  const token = await runDeviceFlow(
    { deviceAuthEndpoint: "https://ex/device", tokenEndpoint: "https://ex/token", clientId: "cid", scope: "api" },
    { fetchImpl: fakeFetch as any, sleep: async () => {}, onPrompt: (a) => { prompted = a.user_code; } },
  );
  assert.equal(token, "tok-123");
  assert.equal(prompted, "WXYZ-1234");
  assert.ok(calls[0].includes("client_id=cid"));
});

import { parseAwsProfile, resolveVertexToken } from "../src/credentials.ts";

test("AWS credential chain parses a named profile from ~/.aws/credentials", () => {
  const ini = [
    "[default]",
    "aws_access_key_id = DEFAULT_KEY",
    "aws_secret_access_key = DEFAULT_SECRET",
    "",
    "[profile prod]",
    "aws_access_key_id = PROD_KEY",
    "aws_secret_access_key = PROD_SECRET",
    "aws_session_token = PROD_TOKEN",
  ].join("\n");
  const def = parseAwsProfile(ini, "default");
  assert.equal(def.accessKeyId, "DEFAULT_KEY");
  const prod = parseAwsProfile(ini, "prod");
  assert.equal(prod.accessKeyId, "PROD_KEY");
  assert.equal(prod.sessionToken, "PROD_TOKEN");
});

test("Vertex ADC returns an explicit access token when present", async () => {
  process.env.GOOGLE_VERTEX_ACCESS_TOKEN = "explicit-token";
  try {
    assert.equal(await resolveVertexToken(), "explicit-token");
  } finally { delete process.env.GOOGLE_VERTEX_ACCESS_TOKEN; }
});
