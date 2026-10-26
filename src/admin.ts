import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GatewayConfig, ProviderConfig, Protocol } from "./config.ts";
import { Registry } from "./registry.ts";
import { listConversations, readConversation, conversationFile, sessionsDir } from "./sessions.ts";

// --- Log ring buffer (shared with gateway via module-level singleton) --------
const LOG_BUFFER_SIZE = 200;
export const logBuffer: string[] = [];
const sseClients: ServerResponse[] = [];

export function pushLog(entry: string): void {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  for (const client of sseClients) {
    try { client.write(`data: ${JSON.stringify(entry)}\n\n`); } catch { /* ignore */ }
  }
}

// --- Paths -------------------------------------------------------------------
function codexHome(): string {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}
function envFile(): string { return resolve(".env"); }
function keysFile(): string { return resolve("omnicodex.keys.json"); }
function catalogFile(): string { return resolve("generated", "codex-models.json"); }
function userConfigFile(): string {
  return process.env.OMNICODEX_CONFIG ? resolve(process.env.OMNICODEX_CONFIG) : resolve("omnicodex.config.json");
}
function communityFile(): string { return resolve("data", "community-providers.json"); }
function configToml(): string { return join(codexHome(), "config.toml"); }
function selectionsFile(): string { return resolve("omnicodex.selections.json"); }

// --- Display metadata for well-known providers -------------------------------
type Meta = { name: string; website: string; color: string };
const PROVIDER_META: Record<string, Meta> = {
  deepseek: { name: "DeepSeek", website: "https://platform.deepseek.com", color: "#1a6cf6" },
  openrouter: { name: "OpenRouter", website: "https://openrouter.ai", color: "#6c47ff" },
  groq: { name: "Groq", website: "https://console.groq.com", color: "#f55036" },
  openai: { name: "OpenAI", website: "https://platform.openai.com", color: "#10a37f" },
  "openai-chatgpt": { name: "OpenAI (ChatGPT OAuth)", website: "https://chatgpt.com", color: "#10a37f" },
  anthropic: { name: "Anthropic", website: "https://console.anthropic.com", color: "#d97757" },
  google: { name: "Google Gemini", website: "https://aistudio.google.com", color: "#4285f4" },
  "google-vertex": { name: "Google Vertex AI", website: "https://cloud.google.com/vertex-ai", color: "#4285f4" },
  azure: { name: "Azure OpenAI", website: "https://azure.microsoft.com", color: "#0078d4" },
  bedrock: { name: "AWS Bedrock", website: "https://aws.amazon.com/bedrock", color: "#ff9900" },
  "amazon-bedrock": { name: "AWS Bedrock", website: "https://aws.amazon.com/bedrock", color: "#ff9900" },
  lmstudio: { name: "LM Studio", website: "https://lmstudio.ai", color: "#7c3aed" },
  ollama: { name: "Ollama", website: "https://ollama.com", color: "#1a1a1a" },
  cohere: { name: "Cohere", website: "https://dashboard.cohere.com", color: "#39594d" },
  vercel: { name: "Vercel AI Gateway", website: "https://vercel.com/ai-gateway", color: "#000000" },
  gitlab: { name: "GitLab Duo", website: "https://gitlab.com", color: "#fc6d26" },
  mock: { name: "Mock (built-in)", website: "", color: "#64748b" },
  francestudent: { name: "France Student (Bridge)", website: "https://ia.francestudent.org", color: "#2563eb" },
  // Extended built-in providers
  mistral: { name: "Mistral AI", website: "https://console.mistral.ai", color: "#fa7343" },
  perplexity: { name: "Perplexity AI", website: "https://www.perplexity.ai", color: "#20808d" },
  together: { name: "Together AI", website: "https://www.together.ai", color: "#6b47ed" },
  fireworks: { name: "Fireworks AI", website: "https://fireworks.ai", color: "#ff6b35" },
  xai: { name: "xAI (Grok)", website: "https://console.x.ai", color: "#1a1a1a" },
  huggingface: { name: "Hugging Face", website: "https://huggingface.co", color: "#ff9d00" },
  nvidia: { name: "NVIDIA NIM", website: "https://build.nvidia.com", color: "#76b900" },
  cerebras: { name: "Cerebras", website: "https://cerebras.ai", color: "#f15a22" },
  sambanova: { name: "SambaNova", website: "https://cloud.sambanova.ai", color: "#c41e3a" },
};

// --- Persistent config (omnicodex.config.json) -------------------------------
type RawProvider = ProviderConfig & { name?: string; website?: string };
type RawConfig = { host?: string; port?: number; providers?: Record<string, RawProvider> };

function loadUserConfig(): RawConfig {
  const file = userConfigFile();
  if (!existsSync(file)) return { providers: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as RawConfig;
    if (!raw.providers) raw.providers = {};
    return raw;
  } catch { return { providers: {} }; }
}
function saveUserConfig(cfg: RawConfig): void {
  writeFileSync(userConfigFile(), JSON.stringify(cfg, null, 2), "utf8");
}

const BUILTIN_IDS = new Set([
  "mock", "deepseek", "groq", "openrouter", "lmstudio", "ollama",
  "openai", "openai-chatgpt", "anthropic", "google", "google-vertex", "cohere", "vercel", "gitlab",
  "mistral", "perplexity", "together", "fireworks", "xai", "huggingface", "nvidia", "cerebras", "sambanova", "bedrock",
  "francestudent",
]);

// --- Key storage (omnicodex.keys.json) ---------------------------------------
type KeyStore = Record<string, string>;
function loadKeys(): KeyStore {
  if (!existsSync(keysFile())) return {};
  try { return JSON.parse(readFileSync(keysFile(), "utf8")) as KeyStore; } catch { return {}; }
}

// Resolve the exact env var the gateway reads for a provider (single source of truth).
function keyEnvFor(registry: Registry, providerId: string): string {
  return registry.provider(providerId)?.keyEnv ?? `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function saveKeys(registry: Registry, keys: KeyStore): void {
  writeFileSync(keysFile(), JSON.stringify(keys, null, 2), "utf8");
  // Mirror to .env using each provider's real env var, and go live in this process.
  const managed = new Map<string, string>();
  for (const [providerId, key] of Object.entries(keys)) {
    if (!key) continue;
    const env = keyEnvFor(registry, providerId);
    managed.set(env, key);
    process.env[env] = key; // ponytail: live immediately, no restart needed for keys
  }
  const existing = existsSync(envFile()) ? readFileSync(envFile(), "utf8") : "";
  const kept = existing.split("\n").filter((l) => {
    const eq = l.indexOf("=");
    return eq === -1 ? l.trim() : !managed.has(l.slice(0, eq).trim());
  });
  const lines = [...managed].map(([env, key]) => `${env}=${key}`);
  writeFileSync(envFile(), [...kept, ...lines].map((l) => l.trim()).filter(Boolean).join("\n") + "\n", "utf8");
}

// --- Model selections ---------------------------------------------------------
type SelectionStore = Record<string, string[]>;
function loadSelections(): SelectionStore {
  if (!existsSync(selectionsFile())) return {};
  try { return JSON.parse(readFileSync(selectionsFile(), "utf8")) as SelectionStore; } catch { return {}; }
}
function saveSelections(sel: SelectionStore): void {
  writeFileSync(selectionsFile(), JSON.stringify(sel, null, 2), "utf8");
}

// --- Provider model listing (test connection) --------------------------------
type RemoteModel = { id: string; context?: number; owned_by?: string };
async function fetchProviderModels(protocol: Protocol, baseURL: string, apiKey: string, providerId: string): Promise<RemoteModel[]> {
  const base = baseURL.replace(/\/+$/, "");
  let url = `${base}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "google") {
    url = `${base}/models`;
    headers["x-goog-api-key"] = apiKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
    if (providerId === "openrouter") { headers["HTTP-Referer"] = "https://github.com/omnicodex"; headers["X-Title"] = "OmniCodex"; }
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json() as { data?: RemoteModel[]; models?: RemoteModel[] };
  return data.data ?? data.models ?? [];
}

// --- Protocol auto-detection (for the wizard) --------------------------------
type DetectResult = {
  protocol: Protocol | null;
  models: string[];
  error?: string;
  hint?: string;
};

async function detectProtocol(baseURL: string, apiKey: string): Promise<DetectResult> {
  const base = baseURL.replace(/\/+$/, "");
  const timeout = 8_000;

  // --- 1. Try OpenAI-compatible /models (most common) -----------------------
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    // Try /models directly, then /v1/models as fallback
    const urls = base.includes("/v1") ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
        if (res.ok) {
          const data = await res.json() as { data?: RemoteModel[]; object?: string };
          if (data.object === "list" || Array.isArray(data.data)) {
            const models = (data.data ?? []).slice(0, 8).map((m) => String(m.id));
            return { protocol: "openai-compatible", models, hint: `Detected ${data.data?.length ?? 0} models` };
          }
        }
      } catch { /* try next */ }
    }
  } catch { /* fall through */ }

  // --- 2. Try Anthropic /models ---------------------------------------------
  try {
    const res = await fetch(`${base}/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = await res.json() as { data?: { id: string }[] };
      if (Array.isArray(data.data) && data.data.some((m) => String(m.id).includes("claude"))) {
        const models = data.data.slice(0, 8).map((m) => String(m.id));
        return { protocol: "anthropic", models, hint: "Detected Anthropic Claude endpoint" };
      }
    }
  } catch { /* fall through */ }

  // --- 3. Try Google Gemini /models -----------------------------------------
  try {
    const url = apiKey
      ? `${base}/models?key=${encodeURIComponent(apiKey)}`
      : `${base}/models`;
    const res = await fetch(url, {
      headers: apiKey ? { "x-goog-api-key": apiKey } : {},
      signal: AbortSignal.timeout(timeout),
    });
    if (res.ok) {
      const data = await res.json() as { models?: { name: string }[] };
      if (Array.isArray(data.models) && data.models.some((m) => m.name?.includes("gemini"))) {
        const models = data.models.slice(0, 8).map((m) => m.name.replace("models/", ""));
        return { protocol: "google", models, hint: "Detected Google Gemini endpoint" };
      }
    }
  } catch { /* fall through */ }

  // --- 4. Try OpenAI Responses API (not just chat) --------------------------
  // The /v1/models endpoint is already tried above; if we get here without a match,
  // try a minimal chat completion to see if the endpoint works at all.
  if (apiKey) {
    try {
      const url = base.includes("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-3.5-turbo", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok || res.status === 400 || res.status === 422) {
        // Even error 400/422 means the server understood the Chat format
        return { protocol: "openai-compatible", models: [], hint: "Server responds to Chat Completions format (no model list available)" };
      }
    } catch { /* fall through */ }
  }

  return { protocol: null, models: [], error: "Could not detect protocol. Try entering it manually.", hint: "Check that the URL is correct and the API key is valid." };
}



// --- Codex profile (config.toml) ---------------------------------------------
function readCodexProfile(): { profile: string; model: string; provider: string } {
  const toml = configToml();
  if (!existsSync(toml)) return { profile: "unknown", model: "unknown", provider: "unknown" };
  const content = readFileSync(toml, "utf8");
  const profileMatch = content.match(/^#\s*active_profile:\s*(\S+)/m);
  const modelMatch = content.match(/^model\s*=\s*["']?([^"'\r\n]+)["']?/m);
  const providerMatch = content.match(/^model_provider\s*=\s*["']?([^"'\r\n]+)["']?/m);
  return {
    profile: profileMatch?.[1] ?? "default",
    model: modelMatch?.[1] ?? "unknown",
    provider: providerMatch?.[1] ?? "openai",
  };
}

function deduplicateToml(content: string): string {
  const lines = content.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
    }
    const eq = trimmed.indexOf("=");
    if (eq !== -1 && !trimmed.startsWith("#")) {
      const key = trimmed.substring(0, eq).trim();
      if (seen.has("key:" + key)) continue;
      seen.add("key:" + key);
    }
    result.push(line);
  }
  return result.join("\n");
}

async function switchProfile(target: "default" | "omnicodex"): Promise<string> {
  const tomlPath = configToml();
  if (!existsSync(tomlPath)) throw new Error("Codex config.toml not found");
  let content = readFileSync(tomlPath, "utf8");

  if (target === "default") {
    content = content.split("\n").filter((l) =>
      !l.startsWith("model_provider") && !l.startsWith("model_catalog_json") &&
      !l.match(/^\[model_providers\.omnicodex\]/) && !l.startsWith("base_url =") &&
      !l.startsWith("wire_api") && !l.startsWith("supports_websockets") &&
      !l.startsWith("requires_openai_auth") && !l.startsWith("name =") &&
      !l.startsWith("model_reasoning_effort") && !l.startsWith("# active_profile:"),
    ).join("\n").replace(/^model\s*=\s*"[^"]+"/m, 'model = "gpt-5.5"').replace(/\n{3,}/g, "\n\n");
    content = "# active_profile: default\n" + content;
    content = deduplicateToml(content);
  } else {
    const omniProfile = join(codexHome(), "omnicodex.config.toml");
    if (!existsSync(omniProfile)) throw new Error("omnicodex.config.toml not found - run 'omnicodex codex install' first");
    const omniContent = readFileSync(omniProfile, "utf8");
    const modelMatch = omniContent.match(/^model\s*=\s*"([^"]+)"/m);
    const catalogMatch = omniContent.match(/^model_catalog_json\s*=\s*'([^']+)'/m) ?? omniContent.match(/^model_catalog_json\s*=\s*"([^"]+)"/m);
    const reasoningMatch = omniContent.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    const model = modelMatch?.[1] ?? "deepseek/deepseek-v4-pro";
    const catalog = catalogMatch?.[1] ?? "";
    const reasoning = reasoningMatch?.[1] ?? "high";
    content = content.split("\n").filter((l) =>
      !l.startsWith("model_provider") && !l.startsWith("model_catalog_json") &&
      !l.match(/^\[model_providers\.omnicodex\]/) && !l.startsWith("base_url =") &&
      !l.startsWith("wire_api") && !l.startsWith("supports_websockets") &&
      !l.startsWith("requires_openai_auth") && !l.startsWith("name ="),
    ).join("\n");
    content = content.replace(/^model\s*=\s*"[^"]+"/m, `model = "${model}"`);
    content = "# active_profile: omnicodex\n" + content;
    content += `\nmodel_provider = "omnicodex"\n`;
    if (catalog) content += `model_catalog_json = '${catalog}'\n`;
    content += `model_reasoning_effort = "${reasoning}"\n`;
    const providerBlock = omniContent.match(/\[model_providers\.omnicodex\][\s\S]*/)?.[0] ?? "";
    content = deduplicateToml(content);
    if (providerBlock && !content.includes("[model_providers.omnicodex]")) content += "\n" + providerBlock;
  }

  const backups = readdirSync(dirname(tomlPath))
    .filter((f) => /^config\.toml\.backup_/.test(f))
    .map((f) => ({ name: f, mtime: statSync(join(dirname(tomlPath), f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const b of backups.slice(2)) rmSync(join(dirname(tomlPath), b.name));
  const backup = `${tomlPath}.backup_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(tomlPath, backup);
  writeFileSync(tomlPath, content.replace(/\n{3,}/g, "\n\n").trim() + "\n", "utf8");
  return `Switched to ${target} profile. Backup: ${backup}`;
}

// --- Route a prompt through the running gateway (works for ALL protocols) ----
async function gatewaySend(port: number, host: string, model: string, system: string, prompt: string): Promise<string> {
  const input: Array<Record<string, unknown>> = [];
  if (system) input.push({ type: "message", role: "developer", content: [{ type: "input_text", text: system }] });
  input.push({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  const res = await fetch(`http://${host}:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, instructions: system || undefined, input, stream: true }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") text += evt.delta;
      } catch { /* ignore */ }
    }
  }
  return text || "(no text output)";
}

// --- HTTP helpers -------------------------------------------------------------
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(value));
}
function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-profile-name");
}
async function bodyText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// --- Admin server -------------------------------------------------------------
export function createAdminServer(config: GatewayConfig): Server {
  const registry = new Registry(config);

  function listProviders(): Array<Record<string, unknown>> {
    const keys = loadKeys();
    const raw = loadUserConfig().providers ?? {};
    return registry.providers().map((p) => {
      const meta = PROVIDER_META[p.id];
      const key = keys[p.id];
      return {
        id: p.id,
        name: raw[p.id]?.name ?? meta?.name ?? p.name ?? p.id,
        website: raw[p.id]?.website ?? meta?.website ?? "",
        color: meta?.color ?? "#6366f1",
        protocol: p.protocol,
        baseURL: p.baseURL ?? "",
        keyEnv: keyEnvFor(registry, p.id),
        enabled: p.enabled,
        configured: p.configured,
        credentialReady: p.credentialReady,
        models: p.models,
        builtin: BUILTIN_IDS.has(p.id),
        hasKey: Boolean(key),
        keyPreview: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : null,
      };
    });
  }

  return createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      // -- Admin UI -----------------------------------------------------------
      if (req.method === "GET" && (path === "/" || path === "/admin" || path === "/index.html")) {
        const uiPath = resolve("public", "index.html");
        const html = existsSync(uiPath) ? await readFile(uiPath, "utf8") : "<h1>Admin UI not found - create public/index.html</h1>";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // -- Status -------------------------------------------------------------
      if (req.method === "GET" && path === "/api/status") {
        const keys = loadKeys();
        return json(res, 200, {
          gatewayPort: config.port,
          adminPort: config.port + 1,
          profile: readCodexProfile(),
          configuredProviders: Object.keys(keys).filter((k) => keys[k]),
          uptime: Math.floor(process.uptime()),
        });
      }

      // -- Providers: list ----------------------------------------------------
      if (req.method === "GET" && path === "/api/providers") {
        return json(res, 200, listProviders());
      }

      // -- Providers: create / update (persistent) ----------------------------
      if ((req.method === "POST" || req.method === "PUT") && path === "/api/providers") {
        const b = JSON.parse(await bodyText(req)) as RawProvider & { id?: string };
        if (!b.id) return json(res, 400, { error: "id required" });
        if (b.protocol !== "mock" && !b.baseURL && !BUILTIN_IDS.has(b.id)) {
          return json(res, 400, { error: "baseURL required" });
        }
        const cfg = loadUserConfig();
        cfg.providers ??= {};
        const prev = cfg.providers[b.id] ?? {};
        cfg.providers[b.id] = {
          ...prev,
          protocol: (b.protocol ?? prev.protocol ?? "openai-compatible") as Protocol,
          ...(b.baseURL !== undefined ? { baseURL: b.baseURL } : {}),
          ...(b.keyEnv !== undefined ? { keyEnv: b.keyEnv } : {}),
          ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.website !== undefined ? { website: b.website } : {}),
        };
        saveUserConfig(cfg);
        return json(res, 200, { ok: true, id: b.id });
      }

      // -- Providers: enable / disable ---------------------------------------
      if (req.method === "POST" && path.match(/^\/api\/providers\/[\w.-]+\/enabled$/)) {
        const id = decodeURIComponent(path.split("/")[3]);
        const b = JSON.parse(await bodyText(req)) as { enabled: boolean };
        const cfg = loadUserConfig();
        cfg.providers ??= {};
        cfg.providers[id] = { ...(cfg.providers[id] ?? {}), enabled: b.enabled } as RawProvider;
        saveUserConfig(cfg);
        return json(res, 200, { ok: true, id, enabled: b.enabled });
      }

      // -- Providers: delete --------------------------------------------------
      if (req.method === "DELETE" && path.match(/^\/api\/providers\/[\w.-]+$/)) {
        const id = decodeURIComponent(path.split("/")[3]);
        const cfg = loadUserConfig();
        cfg.providers ??= {};
        if (BUILTIN_IDS.has(id)) {
          cfg.providers[id] = { ...(cfg.providers[id] ?? {}), enabled: false } as RawProvider; // can't delete built-ins, disable
        } else {
          delete cfg.providers[id];
        }
        saveUserConfig(cfg);
        return json(res, 200, { ok: true, id, disabled: BUILTIN_IDS.has(id) });
      }

      // -- Providers: import from open registry (persistent) ------------------
      if (req.method === "POST" && path === "/api/providers/import-snapshot") {
        const b = JSON.parse(await bodyText(req)) as { ids: string[] };
        if (!b.ids?.length) return json(res, 400, { error: "ids array required" });
        const cfg = loadUserConfig();
        cfg.providers ??= {};
        const added: string[] = [];
        for (const id of b.ids) {
          const snap = registry.snapshot.providers[id];
          if (!snap || snap.protocol === "unsupported") continue;
          cfg.providers[id] = {
            protocol: snap.protocol,
            baseURL: snap.api,
            keyEnv: snap.env?.[0],
            name: snap.name,
          };
          added.push(id);
        }
        saveUserConfig(cfg);
        return json(res, 200, { ok: true, added });
      }

      // -- Snapshot providers (for import UI) ---------------------------------
      if (req.method === "GET" && path === "/api/snapshot-providers") {
        const providers = registry.snapshot.providers;
        return json(res, 200, Object.entries(providers).map(([id, p]) => ({
          id, name: p.name ?? id, protocol: p.protocol, api: p.api ?? "",
        })));
      }

      // -- Keys: set ----------------------------------------------------------
      if (req.method === "POST" && path.match(/^\/api\/providers\/[\w.-]+\/key$/)) {
        const id = decodeURIComponent(path.split("/")[3]);
        const b = JSON.parse(await bodyText(req)) as { key: string };
        const keys = loadKeys();
        keys[id] = b.key?.trim() ?? "";
        saveKeys(registry, keys);
        return json(res, 200, { ok: true, keyEnv: keyEnvFor(registry, id) });
      }

      // -- Keys: delete -------------------------------------------------------
      if (req.method === "DELETE" && path.match(/^\/api\/providers\/[\w.-]+\/key$/)) {
        const id = decodeURIComponent(path.split("/")[3]);
        const keys = loadKeys();
        delete keys[id];
        delete process.env[keyEnvFor(registry, id)];
        saveKeys(registry, keys);
        return json(res, 200, { ok: true });
      }

      // -- Keys: test connection ---------------------------------------------
      if (req.method === "POST" && path.match(/^\/api\/providers\/[\w.-]+\/test$/)) {
        const id = decodeURIComponent(path.split("/")[3]);
        const provider = registry.provider(id);
        if (!provider) return json(res, 404, { error: "Unknown provider" });
        const apiKey = loadKeys()[id] ?? (provider.keyEnv ? process.env[provider.keyEnv] : undefined);
        if (!apiKey) return json(res, 400, { error: "No API key configured" });
        if (!provider.baseURL) return json(res, 400, { error: "Provider has no baseURL" });
        try {
          const models = await fetchProviderModels(provider.protocol, provider.baseURL, apiKey, id);
          return json(res, 200, { ok: true, modelCount: models.length, models });
        } catch (err) {
          return json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // -- Models: list -------------------------------------------------------
      if (req.method === "GET" && path === "/api/models") {
        const selections = loadSelections();
        const catalog = existsSync(catalogFile())
          ? JSON.parse(readFileSync(catalogFile(), "utf8")) as { models: unknown[] }
          : { models: [] };
        return json(res, 200, { catalog: catalog.models, selections });
      }

      // -- Models: save selections -------------------------------------------
      if (req.method === "POST" && path === "/api/models/selections") {
        saveSelections(JSON.parse(await bodyText(req)) as SelectionStore);
        return json(res, 200, { ok: true });
      }

      // -- Models: refresh (rebuild catalog from live provider lists) ---------
      if (req.method === "POST" && path === "/api/models/refresh") {
        const keys = loadKeys();
        const selections = loadSelections();
        const catalogModels: Record<string, unknown>[] = [];
        for (const p of registry.providers()) {
          const provider = registry.provider(p.id);
          if (!provider?.baseURL) continue;
          const apiKey = keys[p.id] ?? (provider.keyEnv ? process.env[provider.keyEnv] : undefined);
          if (!apiKey) continue;
          let models: RemoteModel[] = [];
          try { models = await fetchProviderModels(provider.protocol, provider.baseURL, apiKey, p.id); } catch { continue; }
          const selected = selections[p.id] ?? models.map((m) => m.id);
          for (const model of models) {
            if (!selected.includes(model.id)) continue;
            catalogModels.push(catalogEntry(p.id, model.id));
          }
        }
        writeFileSync(catalogFile(), JSON.stringify({ models: catalogModels }, null, 2), "utf8");
        return json(res, 200, { ok: true, modelCount: catalogModels.length });
      }

      // -- Profile ------------------------------------------------------------
      if (req.method === "GET" && path === "/api/profile") return json(res, 200, readCodexProfile());
      if (req.method === "POST" && path === "/api/profile/switch") {
        const b = JSON.parse(await bodyText(req)) as { target: string };
        if (b.target !== "default" && b.target !== "omnicodex") return json(res, 400, { error: "target must be 'default' or 'omnicodex'" });
        return json(res, 200, { ok: true, output: await switchProfile(b.target) });
      }

      // -- Downloads ----------------------------------------------------------
      if (req.method === "GET" && path === "/api/profile/download") {
        const tomlPath = configToml();
        if (!existsSync(tomlPath)) return json(res, 404, { error: "config.toml not found" });
        const name = String(req.headers["x-profile-name"] ?? "omnicodex");
        return download(res, `${name}.config.toml`, readFileSync(tomlPath, "utf8"));
      }
      if (req.method === "GET" && path === "/api/catalog/download") {
        const content = existsSync(catalogFile()) ? readFileSync(catalogFile(), "utf8") : '{"models":[]}';
        return download(res, "codex-models.json", content);
      }
      if (req.method === "GET" && path === "/api/config/download") {
        return download(res, "omnicodex.config.json", JSON.stringify(loadUserConfig(), null, 2));
      }

      // -- Logs ---------------------------------------------------------------
      if (req.method === "GET" && path === "/api/logs/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        for (const entry of logBuffer) res.write(`data: ${JSON.stringify(entry)}\n\n`);
        sseClients.push(res);
        req.on("close", () => { const i = sseClients.indexOf(res); if (i !== -1) sseClients.splice(i, 1); });
        return;
      }
      if (req.method === "GET" && path === "/api/logs") return json(res, 200, { logs: logBuffer.slice(-100) });

      // -- Conversations (history across all profiles) ------------------------
      if (req.method === "GET" && path === "/api/conversations") {
        return json(res, 200, { conversations: listConversations(), dir: sessionsDir() });
      }
      if (req.method === "GET" && path.match(/^\/api\/conversations\/[^/]+\/download$/)) {
        const id = decodeURIComponent(path.split("/")[3]);
        const file = conversationFile(id);
        if (!file) return json(res, 404, { error: "Conversation not found" });
        return download(res, `${id}.jsonl`, readFileSync(file, "utf8"));
      }
      if (req.method === "GET" && path.match(/^\/api\/conversations\/[^/]+$/)) {
        const id = decodeURIComponent(path.split("/")[3]);
        const conv = readConversation(id);
        return conv ? json(res, 200, conv) : json(res, 404, { error: "Conversation not found" });
      }

      // -- Playground: send through the gateway (all protocols) ---------------
      if (req.method === "POST" && path === "/api/playground/send") {
        const b = JSON.parse(await bodyText(req)) as { model: string; system: string; prompt: string };
        if (!b.model || !b.prompt) return json(res, 400, { error: "model and prompt required" });
        if (b.model.indexOf("/") < 1) return json(res, 400, { error: "model must be provider/model format" });
        try {
          const text = await gatewaySend(config.port, config.host, b.model, b.system ?? "", b.prompt);
          return json(res, 200, { ok: true, text });
        } catch (err) {
          return json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // -- Restart ------------------------------------------------------------
      if (req.method === "POST" && path === "/api/restart") {
        json(res, 200, { ok: true, message: "Restarting..." });
        setTimeout(() => process.exit(0), 500);
        return;
      }

      // -- Provider auto-detect (wizard) -------------------------------------
      if (req.method === "POST" && path === "/api/providers/detect") {
        const b = JSON.parse(await bodyText(req)) as { baseURL: string; apiKey?: string };
        if (!b.baseURL) return json(res, 400, { error: "baseURL required" });
        const base = b.baseURL.replace(/\/+$/, "");
        const key = b.apiKey?.trim() ?? "";
        const detected = await detectProtocol(base, key);
        return json(res, 200, detected);
      }

      // -- Community registry: list ------------------------------------------
      if (req.method === "GET" && path === "/api/community") {
        const file = communityFile();
        if (!existsSync(file)) return json(res, 200, { providers: [] });
        const raw = JSON.parse(readFileSync(file, "utf8")) as { providers: unknown[] };
        const existingProviders = listProviders().map((p) => p.id as string);
        const enriched = (raw.providers ?? []).map((p: Record<string, unknown>) => ({
          ...p,
          installed: existingProviders.includes(p.id as string),
        }));
        return json(res, 200, { providers: enriched, version: (raw as Record<string, unknown>).version ?? "1.0.0" });
      }

      // -- Community registry: install a provider ----------------------------
      if (req.method === "POST" && path === "/api/community/install") {
        const b = JSON.parse(await bodyText(req)) as { id: string };
        if (!b.id) return json(res, 400, { error: "id required" });
        const file = communityFile();
        if (!existsSync(file)) return json(res, 404, { error: "community-providers.json not found" });
        const raw = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, unknown>[] };
        const communityProvider = (raw.providers ?? []).find((p) => p.id === b.id) as Record<string, unknown> | undefined;
        if (!communityProvider) return json(res, 404, { error: `Provider ${b.id} not found in community registry` });
        const cfg = loadUserConfig();
        cfg.providers ??= {};
        // Don't overwrite if already a builtin — only add if truly custom
        if (!BUILTIN_IDS.has(b.id)) {
          cfg.providers[b.id] = {
            protocol: communityProvider.protocol as Protocol,
            baseURL: communityProvider.baseURL as string,
            keyEnv: communityProvider.keyEnv as string,
            name: communityProvider.name as string,
            website: communityProvider.website as string,
          };
          saveUserConfig(cfg);
        }
        // Always update PROVIDER_META if not present
        if (!PROVIDER_META[b.id]) {
          PROVIDER_META[b.id] = {
            name: communityProvider.name as string,
            website: communityProvider.website as string ?? "",
            color: communityProvider.color as string ?? "#6366f1",
          };
        }
        return json(res, 200, { ok: true, id: b.id, builtin: BUILTIN_IDS.has(b.id) });
      }

      // -- Community registry: export a custom provider as community JSON -----
      if (req.method === "GET" && path.match(/^\/api\/community\/export\/[\w.-]+$/)) {
        const id = decodeURIComponent(path.split("/")[4]);
        const provider = registry.provider(id);
        if (!provider) return json(res, 404, { error: "Unknown provider" });
        const meta = PROVIDER_META[id];
        const userCfg = loadUserConfig().providers?.[id] ?? {};
        const exported = {
          id,
          name: (userCfg as Record<string, unknown>).name ?? meta?.name ?? id,
          description: "",
          website: (userCfg as Record<string, unknown>).website ?? meta?.website ?? "",
          docsURL: "",
          keyLink: "",
          color: meta?.color ?? "#6366f1",
          protocol: provider.protocol,
          baseURL: provider.baseURL ?? "",
          keyEnv: provider.keyEnv ?? `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
          author: "community",
          verified: false,
          models: [],
        };
        return json(res, 200, { ok: true, definition: exported });
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
  });
}

function download(res: ServerResponse, filename: string, content: string): void {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${filename}"`,
    "access-control-allow-origin": "*",
  });
  res.end(content);
}

export function catalogEntry(providerId: string, modelId: string): Record<string, unknown> {
  return {
    slug: `${providerId}/${modelId}`,
    display_name: modelId,
    description: `OmniCodex route: ${providerId}/${modelId}`,
    context_window: 128000,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    supports_parallel_tool_calls: true,
    default_reasoning_level: "none",
    supported_reasoning_levels: [],
    priority: 0,
    base_instructions: "You are Codex, a coding agent. Use the provided tools to complete the user's task.",
    experimental_supported_tools: [],
    supports_search_tool: false,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_image_detail_original: false,
    max_context_window: 128000,
    effective_context_window_percent: 95,
    input_modalities: ["text"],
    use_responses_lite: false,
  };
}
