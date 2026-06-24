import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GatewayConfig, ModelConfig, Protocol, ProviderConfig } from "./config.ts";

type SnapshotModel = ModelConfig & { id: string; name: string };
type SnapshotProvider = {
  id: string;
  name: string;
  api?: string;
  env: string[];
  protocol: Protocol;
  models: Record<string, SnapshotModel>;
};
type Snapshot = { generatedAt: string; source: string; providers: Record<string, SnapshotProvider> };

export type ResolvedModel = {
  id: string;
  providerId: string;
  upstreamModel: string;
  provider: ProviderConfig;
  metadata: ModelConfig & { name?: string };
};

function loadSnapshot(path = resolve("data/providers.snapshot.json")): Snapshot {
  if (!existsSync(path)) return { generatedAt: "", source: "", providers: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

export class Registry {
  readonly snapshot = loadSnapshot();
  readonly config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  provider(id: string): ProviderConfig | undefined {
    const configured = this.config.providers[id];
    if (configured) return configured.enabled === false ? undefined : configured;
    const source = this.snapshot.providers[id];
    if (!source || source.protocol === "unsupported") return undefined;
    if (!source.api && !["google-vertex", "amazon-bedrock", "azure", "azure-cognitive-services"].includes(id)) return undefined;
    return {
      protocol: source.protocol,
      baseURL: source.api,
      keyEnv: source.env[0],
      models: source.models
    };
  }

  resolve(id: string): ResolvedModel {
    const slash = id.indexOf("/");
    if (slash < 1 || slash === id.length - 1) {
      throw new Error(`Model must be namespaced as provider/model: ${id}`);
    }
    const providerId = id.slice(0, slash);
    const upstreamModel = id.slice(slash + 1);
    const provider = this.provider(providerId);
    if (!provider) throw new Error(`Provider is not executable: ${providerId}`);
    const metadata =
      provider.models?.[upstreamModel] ??
      this.snapshot.providers[providerId]?.models[upstreamModel] ??
      {};
    return { id, providerId, upstreamModel, provider, metadata };
  }

  providers(): Array<{ id: string; protocol: Protocol; configured: boolean; credentialReady: boolean; models: number }> {
    const ids = new Set([...Object.keys(this.snapshot.providers), ...Object.keys(this.config.providers)]);
    return [...ids].sort().map((id) => {
      const configured = this.config.providers[id];
      const source = this.snapshot.providers[id];
      const provider = this.provider(id);
      return {
        id,
        protocol: configured?.protocol ?? source?.protocol ?? "unsupported",
        configured: Boolean(provider),
        credentialReady: Boolean(
          provider &&
          (
            provider.protocol === "mock" ||
            provider.forwardAuthorization ||
            !provider.keyEnv ||
            process.env[provider.keyEnv]
          )
        ),
        models: Object.keys(configured?.models ?? source?.models ?? {}).length
      };
    });
  }

  models(providerFilter?: string): ResolvedModel[] {
    const output: ResolvedModel[] = [];
    for (const item of this.providers()) {
      if (providerFilter && item.id !== providerFilter) continue;
      const provider = this.provider(item.id);
      if (!provider) continue;
      const models = {
        ...(this.snapshot.providers[item.id]?.models ?? {}),
        ...(provider.models ?? {})
      };
      for (const [model, metadata] of Object.entries(models)) {
        output.push({
          id: `${item.id}/${model}`,
          providerId: item.id,
          upstreamModel: model,
          provider,
          metadata
        });
      }
    }
    return output;
  }
}
