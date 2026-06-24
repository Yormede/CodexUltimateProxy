import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import { Registry } from "../src/registry.ts";

export function generateCodexCatalog(target = resolve("generated/codex-models.json")): string {
  const registry = new Registry(loadConfig());
  const selected = new Set((process.env.OMNICODEX_CATALOG_PROVIDERS ?? "mock,deepseek,lmstudio,openai,openai-chatgpt,anthropic,google").split(","));
  const models = registry.models()
    .filter((model) => selected.has(model.providerId) && model.metadata.tools !== false)
    .map((model, priority) => ({
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    input_modalities: model.metadata.vision ? ["text", "image"] : ["text"],
    supports_image_detail_original: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: model.metadata.tools !== false,
    context_window: model.metadata.context ?? 128000,
    max_context_window: model.metadata.context ?? 128000,
    auto_compact_token_limit: null,
    default_reasoning_summary: "none",
    default_reasoning_level: model.metadata.reasoning ? "medium" : "none",
    supported_reasoning_levels: model.metadata.reasoning
      ? [
          { effort: "low", description: "Lower reasoning effort" },
          { effort: "medium", description: "Balanced reasoning effort" },
          { effort: "high", description: "Higher reasoning effort" }
        ]
      : [],
    slug: model.id,
    display_name: model.metadata.name ?? model.id,
    description: `OmniCodex route: ${model.id}`,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority,
    base_instructions: "You are Codex, a coding agent. Use the provided tools to complete the user's task.",
    experimental_supported_tools: [],
    supports_search_tool: false,
    supports_reasoning_summaries: false
  }));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ models }, null, 2)}\n`);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(generateCodexCatalog());
}
