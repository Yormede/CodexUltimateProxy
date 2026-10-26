import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

// Codex stores conversation rollouts as JSONL under ~/.codex/sessions/YYYY/MM/DD/.
// They are written regardless of which profile launched Codex, so aggregating the
// whole tree recovers every conversation across every profile.
function codexHome(): string {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}
export function sessionsDir(): string {
  return process.env.OMNICODEX_SESSIONS_DIR ? resolve(process.env.OMNICODEX_SESSIONS_DIR) : join(codexHome(), "sessions");
}

type Json = Record<string, unknown>;

export type Turn = { role: string; text: string; kind: string };
export type Conversation = {
  id: string;
  file: string;
  mtime: number;
  timestamp?: string;
  model?: string;
  provider?: string;
  cwd?: string;
  turns: number;
  preview: string;
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl") && /rollout|session|history/i.test(entry.name)) out.push(full);
  }
  return out;
}

// Tolerant text extraction across Codex rollout schema variants.
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") {
        const part = p as Json;
        if (typeof part.text === "string") return part.text;
        return extractText(part.content);
      }
      return "";
    }).join("");
  }
  return "";
}

// Unwrap a rollout line into a normalized item (schemas nest under .payload or .item in some versions).
function unwrap(line: Json): Json {
  if (line.payload && typeof line.payload === "object") return line.payload as Json;
  if (line.item && typeof line.item === "object") return line.item as Json;
  return line;
}

function lineToTurn(raw: Json): Turn | undefined {
  const item = unwrap(raw);
  const type = String(item.type ?? item.record_type ?? "");
  if (type === "message" || (item.role && item.content !== undefined)) {
    const role = String(item.role ?? "user");
    const text = extractText(item.content);
    if (!text.trim()) return undefined;
    return { role, text, kind: "message" };
  }
  if (type === "function_call" || item.name && item.arguments !== undefined) {
    return { role: "tool", text: `${String(item.name ?? "call")}(${String(item.arguments ?? "")})`, kind: "function_call" };
  }
  if (type === "function_call_output" || item.output !== undefined) {
    return { role: "tool", text: extractText(item.output) || String(item.output ?? ""), kind: "function_call_output" };
  }
  if (type === "reasoning") {
    const text = extractText(item.summary ?? item.content);
    return text.trim() ? { role: "reasoning", text, kind: "reasoning" } : undefined;
  }
  return undefined;
}

function parseFile(file: string): { meta: Json; turns: Turn[] } {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  let meta: Json = {};
  const turns: Turn[] = [];
  for (const line of lines) {
    let obj: Json;
    try { obj = JSON.parse(line) as Json; } catch { continue; }
    const inner = unwrap(obj);
    const t = String(obj.type ?? inner.type ?? obj.record_type ?? "");
    if (t === "session_meta" || t === "session" || inner.instructions !== undefined && !turns.length) {
      meta = { ...meta, ...inner, timestamp: obj.timestamp ?? inner.timestamp };
      continue;
    }
    const turn = lineToTurn(obj);
    if (turn) turns.push(turn);
  }
  return { meta, turns };
}

export function listConversations(limit = 200): Conversation[] {
  const files = walk(sessionsDir());
  const items = files.map((file) => {
    const mtime = statSync(file).mtimeMs;
    let parsed: { meta: Json; turns: Turn[] };
    try { parsed = parseFile(file); } catch { parsed = { meta: {}, turns: [] }; }
    const firstUser = parsed.turns.find((t) => t.role === "user");
    const model = parsed.meta.model as string | undefined;
    return {
      id: basename(file, ".jsonl"),
      file,
      mtime,
      timestamp: (parsed.meta.timestamp as string | undefined) ?? new Date(mtime).toISOString(),
      model,
      provider: model && model.includes("/") ? model.split("/")[0] : (parsed.meta.provider as string | undefined),
      cwd: parsed.meta.cwd as string | undefined,
      turns: parsed.turns.length,
      preview: (firstUser?.text ?? "").slice(0, 140).replace(/\s+/g, " ").trim(),
    } satisfies Conversation;
  });
  return items.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// Resolve an id back to a file safely (no path traversal — id must match a known basename).
export function conversationFile(id: string): string | undefined {
  return walk(sessionsDir()).find((f) => basename(f, ".jsonl") === id);
}

export function readConversation(id: string): { id: string; meta: Json; turns: Turn[] } | undefined {
  const file = conversationFile(id);
  if (!file) return undefined;
  const { meta, turns } = parseFile(file);
  return { id, meta, turns };
}
