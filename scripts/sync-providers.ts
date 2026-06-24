import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Protocol } from "../src/config.ts";

type Json = Record<string, any>;

function protocol(npm = ""): Protocol {
  if (npm === "@ai-sdk/openai") return "responses";
  if (npm === "@ai-sdk/openai-compatible" || npm.includes("openrouter")) return "openai-compatible";
  if (npm.includes("anthropic")) return "anthropic";
  if (npm === "@ai-sdk/google") return "google";
  if (npm === "@ai-sdk/google-vertex") return "google-vertex";
  if (npm.includes("amazon-bedrock")) return "bedrock";
  if (npm === "@ai-sdk/azure") return "azure";
  return "unsupported";
}

function model(value: Json): Json {
  return {
    id: value.id,
    name: value.name,
    context: value.limit?.context,
    output: value.limit?.output,
    tools: Boolean(value.tool_call),
    vision: value.modalities?.input?.includes("image") ?? false,
    reasoning: Boolean(value.reasoning)
  };
}

export async function syncProviders(): Promise<{ providers: number; models: number }> {
  const response = await fetch("https://models.dev/api.json");
  if (!response.ok) throw new Error(`Models.dev returned ${response.status}`);
  const source = await response.json() as Record<string, Json>;
  const providers = Object.fromEntries(Object.entries(source).map(([id, value]) => {
    const sourceModels = Object.entries(value.models ?? {});
    const supportedModels = id === "deepseek"
      ? sourceModels.filter(([modelId]) => ["deepseek-v4-pro", "deepseek-v4-flash"].includes(modelId))
      : sourceModels;
    return [id, {
      id,
      name: value.name ?? id,
      api: value.api,
      env: Array.isArray(value.env) ? value.env : [],
      npm: value.npm,
      protocol: protocol(value.npm),
      models: Object.fromEntries(supportedModels.map(([modelId, data]) => [modelId, model(data as Json)]))
    }];
  }));
  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "https://models.dev/api.json",
    providers
  };
  const target = resolve("data/providers.snapshot.json");
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (existsSync(target)) {
    const previous = JSON.parse(readFileSync(target, "utf8")) as Json;
    const removed = Object.keys(previous.providers ?? {}).filter((id) => !(id in providers));
    if (removed.length) console.warn(`Providers removed upstream but retained only in git history: ${removed.join(", ")}`);
  }
  renameSync(temporary, target);

  const rows = Object.values(providers).map((provider: any) =>
    `| ${provider.id} | ${provider.protocol} | ${provider.env.join(", ") || "none"} | ${Object.keys(provider.models).length} | ${["responses", "openai-compatible", "anthropic", "google", "google-vertex", "azure", "bedrock"].includes(provider.protocol) ? "adapter available" : "discovered only"} |`
  );
  writeFileSync(resolve("docs/provider-parity.md"), [
    "# Provider parity",
    "",
    `Generated: ${snapshot.generatedAt}`,
    "",
    "| Provider | Protocol | Auth env | Models | OmniCodex status |",
    "|---|---|---|---:|---|",
    ...rows,
    ""
  ].join("\n"));
  return {
    providers: Object.keys(providers).length,
    models: Object.values(providers).reduce((count: number, provider: any) => count + Object.keys(provider.models).length, 0)
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await syncProviders());
}
