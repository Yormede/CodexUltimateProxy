import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// ─── Log ring buffer (shared with gateway via module-level singleton) ────────
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

// ─── Paths ───────────────────────────────────────────────────────────────────
function codexHome(): string {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}
function envFile(): string {
  return resolve(".env");
}
function keysFile(): string {
  return resolve("omnicodex.keys.json");
}
function catalogFile(): string {
  return resolve("generated", "codex-models.json");
}
function configToml(): string {
  return join(codexHome(), "config.toml");
}

// ─── Key storage (omnicodex.keys.json) ───────────────────────────────────────
type KeyStore = Record<string, string>;

function loadKeys(): KeyStore {
  if (!existsSync(keysFile())) return {};
  try { return JSON.parse(readFileSync(keysFile(), "utf8")) as KeyStore; } catch { return {}; }
}

function saveKeys(keys: KeyStore): void {
  writeFileSync(keysFile(), JSON.stringify(keys, null, 2), "utf8");
  const lines = Object.entries(keys)
    .map(([provider, key]) => `${providerEnvKey(provider)}=${key}`);
  let existing = existsSync(envFile()) ? readFileSync(envFile(), "utf8") : "";
  existing = existing.split("\n")
    .filter(l => !Object.keys(PROVIDERS).some(p => l.startsWith(providerEnvKey(p) + "=")))
    .join("\n");
  writeFileSync(envFile(), [existing.trim(), ...lines].filter(Boolean).join("\n") + "\n", "utf8");
}

function providerEnvKey(providerId: string): string {
  const map: Record<string, string> = {
    deepseek: "DEEPSEEK_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    openai: "OPENAI_API_KEY",
    opencode: "OPENCODE_API_KEY",
  };
  return map[providerId] ?? `${providerId.toUpperCase()}_API_KEY`;
}

// ─── Provider definitions ─────────────────────────────────────────────────────
export type ProviderDef = {
  id: string;
  name: string;
  icon: string;
  baseURL: string;
  modelsEndpoint?: string;
  authHeader: "Bearer" | "x-api-key";
  color: string;
  website: string;
};

export const PROVIDERS: Record<string, ProviderDef> = {
  deepseek: {
    id: "deepseek", name: "DeepSeek", icon: "🔷",
    baseURL: "https://api.deepseek.com", authHeader: "Bearer",
    color: "#1a6cf6", website: "https://platform.deepseek.com",
  },
  openrouter: {
    id: "openrouter", name: "OpenRouter", icon: "🔀",
    baseURL: "https://openrouter.ai/api/v1", authHeader: "Bearer",
    color: "#6c47ff", website: "https://openrouter.ai",
  },
  groq: {
    id: "groq", name: "Groq", icon: "⚡",
    baseURL: "https://api.groq.com/openai/v1", authHeader: "Bearer",
    color: "#f55036", website: "https://console.groq.com",
  },
  openai: {
    id: "openai", name: "OpenAI", icon: "🤖",
    baseURL: "https://api.openai.com/v1", authHeader: "Bearer",
    color: "#10a37f", website: "https://platform.openai.com",
  },
  opencode: {
    id: "opencode", name: "OpenCode Go", icon: "🚀",
    baseURL: "https://api.opencode.com/v1", authHeader: "Bearer",
    color: "#ff6b35", website: "https://opencode.com",
  },
};

// ─── Fetch models from provider ───────────────────────────────────────────────
type RemoteModel = { id: string; context?: number; owned_by?: string };

async function fetchProviderModels(def: ProviderDef, apiKey: string): Promise<RemoteModel[]> {
  const url = `${def.baseURL}/models`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(def.id === "openrouter" ? { "HTTP-Referer": "https://github.com/omnicodex", "X-Title": "OmniCodex" } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json() as { data?: RemoteModel[]; models?: RemoteModel[] };
  return data.data ?? data.models ?? [];
}

// ─── Load/save model selections ───────────────────────────────────────────────
type SelectionStore = Record<string, string[]>;

function selectionsFile(): string {
  return resolve("omnicodex.selections.json");
}
function loadSelections(): SelectionStore {
  if (!existsSync(selectionsFile())) return {};
  try { return JSON.parse(readFileSync(selectionsFile(), "utf8")) as SelectionStore; } catch { return {}; }
}
function saveSelections(sel: SelectionStore): void {
  writeFileSync(selectionsFile(), JSON.stringify(sel, null, 2), "utf8");
}

// ─── Read current Codex profile ───────────────────────────────────────────────
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

// ─── Switch Codex profile (direct TOML edit, no external script) ──────────────
async function switchProfile(target: "default" | "omnicodex"): Promise<string> {
  const tomlPath = configToml();
  if (!existsSync(tomlPath)) throw new Error("Codex config.toml not found");

  let content = readFileSync(tomlPath, "utf8");

  if (target === "default") {
    content = content
      .split("\n")
      .filter(l =>
        !l.startsWith("model_provider") &&
        !l.startsWith("model_catalog_json") &&
        !l.match(/^\[model_providers\.omnicodex\]/) &&
        !l.startsWith("base_url =") &&
        !l.startsWith("wire_api") &&
        !l.startsWith("supports_websockets") &&
        !l.startsWith("requires_openai_auth") &&
        !l.startsWith("name =") &&
        !l.startsWith("# active_profile:")
      )
      .join("\n")
      .replace(/^model\s*=\s*"[^"]+"/m, 'model = "gpt-5.5"')
      .replace(/\n{3,}/g, "\n\n");
    content = "# active_profile: default\n" + content;
  } else {
    const omniProfile = join(codexHome(), "omnicodex.config.toml");
    if (!existsSync(omniProfile)) throw new Error("omnicodex.config.toml not found — run 'omnicodex codex install' first");
    const omniContent = readFileSync(omniProfile, "utf8");

    const modelMatch = omniContent.match(/^model\s*=\s*"([^"]+)"/m);
    const catalogMatch = omniContent.match(/^model_catalog_json\s*=\s*'([^']+)'/m) ?? omniContent.match(/^model_catalog_json\s*=\s*"([^"]+)"/m);
    const reasoningMatch = omniContent.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);

    const model = modelMatch?.[1] ?? "deepseek/deepseek-v4-pro";
    const catalog = catalogMatch?.[1] ?? "";
    const reasoning = reasoningMatch?.[1] ?? "high";

    content = content
      .split("\n")
      .filter(l =>
        !l.startsWith("model_provider") &&
        !l.startsWith("model_catalog_json") &&
        !l.match(/^\[model_providers\.omnicodex\]/) &&
        !l.startsWith("base_url =") &&
        !l.startsWith("wire_api") &&
        !l.startsWith("supports_websockets") &&
        !l.startsWith("requires_openai_auth") &&
        !l.startsWith("name =")
      )
      .join("\n");

    content = content.replace(/^model\s*=\s*"[^"]+"/m, `model = "${model}"`);
    content = "# active_profile: omnicodex\n" + content;
    content += `\nmodel_provider = "omnicodex"\n`;
    if (catalog) content += `model_catalog_json = '${catalog}'\n`;
    content += `model_reasoning_effort = "${reasoning}"\n`;

    const providerBlock = omniContent.match(/\[model_providers\.omnicodex\][\s\S]*/)?.[0] ?? "";
    if (providerBlock && !content.includes("[model_providers.omnicodex]")) {
      content += "\n" + providerBlock;
    }
  }

  // Keep only last 3 backups, then write new one
  const backupPattern = /^config\.toml\.backup_/;
  const backups = readdirSync(dirname(tomlPath))
    .filter(f => backupPattern.test(f))
    .map(f => ({ name: f, mtime: statSync(join(dirname(tomlPath), f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const b of backups.slice(2)) {
    rmSync(join(dirname(tomlPath), b.name));
  }

  const backup = `${tomlPath}.backup_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(tomlPath, backup);
  writeFileSync(tomlPath, content.replace(/\n{3,}/g, "\n\n").trim() + "\n", "utf8");

  return `Switched to ${target} profile. Backup: ${backup}`;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(value));
}

function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

async function bodyText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// ─── Admin server ─────────────────────────────────────────────────────────────
export function createAdminServer(config: { host: string; port: number }): Server {
  return createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      // ── Serve admin UI ──────────────────────────────────────────────────────
      if (req.method === "GET" && (path === "/" || path === "/admin" || path === "/index.html")) {
        const uiPath = resolve("public", "index.html");
        const html = existsSync(uiPath)
          ? await readFile(uiPath, "utf8")
          : "<h1>Admin UI not found — create public/index.html</h1>";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // ── GET /api/status ─────────────────────────────────────────────────────
      if (req.method === "GET" && path === "/api/status") {
        const profile = readCodexProfile();
        const keys = loadKeys();
        return json(res, 200, {
          gatewayPort: config.port,
          adminPort: config.port + 1,
          profile,
          configuredProviders: Object.keys(keys).filter(k => keys[k]),
          uptime: Math.floor(process.uptime()),
        });
      }

      // ── GET /api/providers ─────────────────────────────────────────────────
      if (req.method === "GET" && path === "/api/providers") {
        const keys = loadKeys();
        const result = Object.values(PROVIDERS).map(def => ({
          ...def,
          hasKey: Boolean(keys[def.id]),
          keyPreview: keys[def.id] ? `${keys[def.id].slice(0, 6)}...${keys[def.id].slice(-4)}` : null,
        }));
        return json(res, 200, result);
      }

      // ── POST /api/providers/:id/key ────────────────────────────────────────
      if (req.method === "POST" && path.match(/^\/api\/providers\/[\w-]+\/key$/)) {
        const providerId = path.split("/")[3];
        if (!PROVIDERS[providerId]) return json(res, 404, { error: "Unknown provider" });
        const body = JSON.parse(await bodyText(req)) as { key: string };
        const keys = loadKeys();
        keys[providerId] = body.key?.trim() ?? "";
        saveKeys(keys);
        return json(res, 200, { ok: true });
      }

      // ── DELETE /api/providers/:id/key ──────────────────────────────────────
      if (req.method === "DELETE" && path.match(/^\/api\/providers\/[\w-]+\/key$/)) {
        const providerId = path.split("/")[3];
        const keys = loadKeys();
        delete keys[providerId];
        saveKeys(keys);
        return json(res, 200, { ok: true });
      }

      // ── POST /api/providers/:id/test ───────────────────────────────────────
      if (req.method === "POST" && path.match(/^\/api\/providers\/[\w-]+\/test$/)) {
        const providerId = path.split("/")[3];
        const def = PROVIDERS[providerId];
        if (!def) return json(res, 404, { error: "Unknown provider" });
        const keys = loadKeys();
        const apiKey = keys[providerId];
        if (!apiKey) return json(res, 400, { error: "No API key configured" });
        try {
          const models = await fetchProviderModels(def, apiKey);
          return json(res, 200, { ok: true, modelCount: models.length, models });
        } catch (err) {
          return json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // ── GET /api/models ────────────────────────────────────────────────────
      if (req.method === "GET" && path === "/api/models") {
        const selections = loadSelections();
        const catalog = existsSync(catalogFile())
          ? JSON.parse(readFileSync(catalogFile(), "utf8")) as { models: unknown[] }
          : { models: [] };
        return json(res, 200, { catalog: catalog.models, selections });
      }

      // ── POST /api/models/selections ────────────────────────────────────────
      if (req.method === "POST" && path === "/api/models/selections") {
        const body = JSON.parse(await bodyText(req)) as SelectionStore;
        saveSelections(body);
        return json(res, 200, { ok: true });
      }

      // ── POST /api/models/refresh ───────────────────────────────────────────
      if (req.method === "POST" && path === "/api/models/refresh") {
        const keys = loadKeys();
        const allModels: Record<string, RemoteModel[]> = {};
        for (const [id, def] of Object.entries(PROVIDERS)) {
          if (!keys[id]) continue;
          try { allModels[id] = await fetchProviderModels(def, keys[id]); }
          catch { allModels[id] = []; }
        }
        const selections = loadSelections();
        const catalogModels: Record<string, unknown>[] = [];
        for (const [providerId, models] of Object.entries(allModels)) {
          const selected = selections[providerId] ?? models.map(m => m.id);
          for (const model of models) {
            if (!selected.includes(model.id)) continue;
            catalogModels.push({
              slug: `${providerId}/${model.id}`,
              display_name: model.id,
              description: `OmniCodex route: ${providerId}/${model.id}`,
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
            });
          }
        }
        const newCatalog = { models: catalogModels };
        writeFileSync(catalogFile(), JSON.stringify(newCatalog, null, 2), "utf8");
        return json(res, 200, { ok: true, modelCount: catalogModels.length });
      }

      // ── GET /api/profile ───────────────────────────────────────────────────
      if (req.method === "GET" && path === "/api/profile") {
        return json(res, 200, readCodexProfile());
      }

      // ── POST /api/profile/switch ───────────────────────────────────────────
      if (req.method === "POST" && path === "/api/profile/switch") {
        const body = JSON.parse(await bodyText(req)) as { target: string };
        if (body.target !== "default" && body.target !== "omnicodex") {
          return json(res, 400, { error: "target must be 'default' or 'omnicodex'" });
        }
        const output = await switchProfile(body.target as "default" | "omnicodex");
        return json(res, 200, { ok: true, output });
      }

      // ── GET /api/profile/download ──────────────────────────────────────────
      if (req.method === "GET" && path === "/api/profile/download") {
        const tomlPath = configToml();
        if (!existsSync(tomlPath)) return json(res, 404, { error: "config.toml not found" });
        const content = readFileSync(tomlPath, "utf8");
        const profileName = req.headers["x-profile-name"] ?? "omnicodex";
        const filename = `${profileName}.config.toml`;
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${filename}"`,
          "access-control-allow-origin": "*",
        });
        res.end(content);
        return;
      }

      // ── GET /api/logs/stream (SSE) ─────────────────────────────────────────
      if (req.method === "GET" && path === "/api/logs/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": "*",
        });
        for (const entry of logBuffer) {
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
        sseClients.push(res);
        req.on("close", () => {
          const idx = sseClients.indexOf(res);
          if (idx !== -1) sseClients.splice(idx, 1);
        });
        return;
      }

      // ── GET /api/logs ──────────────────────────────────────────────────────
      if (req.method === "GET" && path === "/api/logs") {
        return json(res, 200, { logs: logBuffer.slice(-100) });
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
  });
}
