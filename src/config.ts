import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Protocol =
  | "mock"
  | "responses"
  | "openai-compatible"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "azure"
  | "bedrock"
  | "unsupported";

export type ModelConfig = {
  name?: string;
  context?: number;
  output?: number;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
};

export type ProviderConfig = {
  protocol: Protocol;
  baseURL?: string;
  keyEnv?: string;
  forwardAuthorization?: boolean;
  enabled?: boolean;
  models?: Record<string, ModelConfig>;
};

export type GatewayConfig = {
  host: string;
  port: number;
  providers: Record<string, ProviderConfig>;
};

const defaults: GatewayConfig = {
  host: "127.0.0.1",
  port: 4141,
  providers: {
    mock: {
      protocol: "mock",
      models: {
        echo: { name: "OmniCodex Echo", context: 128000, output: 8192, tools: true },
        tool: { name: "OmniCodex Tool Test", context: 128000, output: 8192, tools: true }
      }
    },
    deepseek: {
      protocol: "openai-compatible",
      baseURL: "https://api.deepseek.com",
      keyEnv: "DEEPSEEK_API_KEY"
    },
    lmstudio: {
      protocol: "openai-compatible",
      baseURL: "http://127.0.0.1:1234/v1",
      keyEnv: "LMSTUDIO_API_KEY"
    },
    ollama: {
      protocol: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1"
    },
    openai: {
      protocol: "responses",
      baseURL: "https://api.openai.com/v1",
      keyEnv: "OPENAI_API_KEY"
    },
    "openai-chatgpt": {
      protocol: "responses",
      baseURL: "https://chatgpt.com/backend-api/codex",
      forwardAuthorization: true,
      models: {
        "gpt-5.5": { name: "GPT-5.5 (ChatGPT OAuth)", context: 272000, output: 128000, tools: true, vision: true, reasoning: true },
        "gpt-5.4": { name: "GPT-5.4 (ChatGPT OAuth)", context: 272000, output: 128000, tools: true, vision: true, reasoning: true },
        "gpt-5.4-mini": { name: "GPT-5.4 Mini (ChatGPT OAuth)", context: 400000, output: 128000, tools: true, vision: true, reasoning: true }
      }
    },
    anthropic: {
      protocol: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      keyEnv: "ANTHROPIC_API_KEY"
    },
    google: {
      protocol: "google",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      keyEnv: "GEMINI_API_KEY"
    }
  }
};

function assertConfig(config: GatewayConfig): void {
  if (!config.host || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("Invalid host or port");
  }
  const local = ["127.0.0.1", "::1", "localhost"].includes(config.host);
  if (!local && process.env.OMNICODEX_ALLOW_REMOTE !== "1") {
    throw new Error("Remote listening requires OMNICODEX_ALLOW_REMOTE=1");
  }
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.enabled === false || provider.protocol === "mock") continue;
    if (!provider.baseURL) throw new Error(`Provider ${id} needs baseURL`);
    const url = new URL(provider.baseURL);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Provider ${id} only supports HTTP(S) URLs`);
    }
    if (url.username || url.password) throw new Error(`Provider ${id} URL must not contain credentials`);
    if (provider.forwardAuthorization && (provider.protocol !== "responses" || !id.startsWith("openai"))) {
      throw new Error(`Provider ${id} cannot forward inbound Authorization`);
    }
  }
}

export function loadConfig(path = process.env.OMNICODEX_CONFIG): GatewayConfig {
  const file = path ? resolve(path) : resolve("omnicodex.config.json");
  const input = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Partial<GatewayConfig> : {};
  const config: GatewayConfig = {
    host: process.env.OMNICODEX_HOST ?? input.host ?? defaults.host,
    port: Number(process.env.OMNICODEX_PORT ?? input.port ?? defaults.port),
    providers: { ...defaults.providers, ...(input.providers ?? {}) }
  };
  assertConfig(config);
  return config;
}
