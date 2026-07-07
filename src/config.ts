import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Protocol =
  | "francestudent"
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
    groq: {
      protocol: "openai-compatible",
      baseURL: "https://api.groq.com/openai/v1",
      keyEnv: "GROQ_API_KEY"
    },
    openrouter: {
      protocol: "openai-compatible",
      baseURL: "https://openrouter.ai/api/v1",
      keyEnv: "OPENROUTER_API_KEY"
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
    },
    "google-vertex": {
      // Requires GOOGLE_VERTEX_PROJECT + GOOGLE_VERTEX_LOCATION env vars (or ADC via credentials.ts)
      protocol: "google-vertex",
      enabled: false
    },
    cohere: {
      protocol: "openai-compatible",
      baseURL: "https://api.cohere.ai/compatibility/v1",
      keyEnv: "COHERE_API_KEY"
    },
    vercel: {
      protocol: "openai-compatible",
      baseURL: "https://ai-gateway.vercel.sh/v1",
      keyEnv: "AI_GATEWAY_API_KEY"
    },
    gitlab: {
      // GitLab Duo self-hosted AI gateway is OpenAI-compatible; set your instance base URL then enable.
      protocol: "openai-compatible",
      baseURL: "https://gitlab.com/api/v4",
      keyEnv: "GITLAB_API_KEY",
      enabled: false
    },
    // --- Extended providers (enabled by default, key required) ----------------
    mistral: {
      protocol: "openai-compatible",
      baseURL: "https://api.mistral.ai/v1",
      keyEnv: "MISTRAL_API_KEY"
    },
    perplexity: {
      protocol: "openai-compatible",
      baseURL: "https://api.perplexity.ai",
      keyEnv: "PERPLEXITY_API_KEY"
    },
    together: {
      protocol: "openai-compatible",
      baseURL: "https://api.together.xyz/v1",
      keyEnv: "TOGETHER_API_KEY"
    },
    fireworks: {
      protocol: "openai-compatible",
      baseURL: "https://api.fireworks.ai/inference/v1",
      keyEnv: "FIREWORKS_API_KEY"
    },
    xai: {
      protocol: "openai-compatible",
      baseURL: "https://api.x.ai/v1",
      keyEnv: "XAI_API_KEY"
    },
    huggingface: {
      protocol: "openai-compatible",
      baseURL: "https://api-inference.huggingface.co/v1",
      keyEnv: "HF_API_KEY"
    },
    nvidia: {
      protocol: "openai-compatible",
      baseURL: "https://integrate.api.nvidia.com/v1",
      keyEnv: "NVIDIA_API_KEY"
    },
    cerebras: {
      protocol: "openai-compatible",
      baseURL: "https://api.cerebras.ai/v1",
      keyEnv: "CEREBRAS_API_KEY"
    },
    sambanova: {
      protocol: "openai-compatible",
      baseURL: "https://api.sambanova.ai/v1",
      keyEnv: "SAMBANOVA_API_KEY"
    },
    francestudent: {
      protocol: "francestudent",
      baseURL: "http://127.0.0.1:8765",
      models: {
        "claude-sonnet-4-6": { name: "Claude Sonnet 4.6 (France Student)", context: 200000, output: 8192, tools: true },
        "claude-opus-4-8": { name: "Claude Opus 4.8 (France Student)", context: 200000, output: 8192, tools: true },
        "claude-haiku-4-5": { name: "Claude Haiku 4.5 (France Student)", context: 200000, output: 8192, tools: true },
        "deepseek-v3.2": { name: "DeepSeek V3.2 (France Student)", context: 128000, output: 8192, tools: true },
        "mistral-large-3": { name: "Mistral Large 3 (France Student)", context: 128000, output: 8192, tools: true },
        "kimi-k2.5": { name: "Kimi K2.5 (France Student)", context: 128000, output: 8192, tools: true },
        "gpt-5.4-nano": { name: "GPT-5.4 Nano (France Student)", context: 128000, output: 8192, tools: true },
      }
    },
        bedrock: {
      // Requires AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_BEARER_TOKEN_BEDROCK)
      protocol: "bedrock",
      enabled: false
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
  // ponytail: load .env so snapshot providers (openrouter, groq, etc.) find their keys
  const envPath = resolve(".env");
  if (existsSync(envPath)) {
    try { process.loadEnvFile(envPath); } catch { /* ignore malformed .env */ }
  }
  const file = path ? resolve(path) : resolve("omnicodex.config.json");
  const raw = existsSync(file) ? readFileSync(file, "utf8").replace(/^\uFEFF/, "") : "{}";
  const input = JSON.parse(raw) as Partial<GatewayConfig>;
  const config: GatewayConfig = {
    host: process.env.OMNICODEX_HOST ?? input.host ?? defaults.host,
    port: Number(process.env.OMNICODEX_PORT ?? input.port ?? defaults.port),
    providers: { ...defaults.providers, ...(input.providers ?? {}) }
  };
  assertConfig(config);
  return config;
}
