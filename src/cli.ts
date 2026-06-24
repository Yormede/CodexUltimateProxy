#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.ts";
import { Registry } from "./registry.ts";
import { createGatewayServer } from "./server.ts";
import { createAdminServer } from "./admin.ts";
import { syncProviders } from "../scripts/sync-providers.ts";
import { generateCodexCatalog } from "../scripts/generate-codex-catalog.ts";

const command = process.argv[2] ?? "serve";
const config = loadConfig();
const registry = new Registry(config);

function codexHome(): string {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}

function profilePath(): string {
  return join(codexHome(), "omnicodex.config.toml");
}

function tomlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function installCodex(): void {
  const catalog = generateCodexCatalog();
  const profile = profilePath();
  mkdirSync(dirname(profile), { recursive: true });
  const backup = `${profile}.bak`;
  if (existsSync(profile) && !existsSync(backup)) renameSync(profile, backup);
  const oauth = process.env.OMNICODEX_USE_CODEX_OAUTH !== "0";
  const defaultModel = oauth
    ? "openai-chatgpt/gpt-5.5"
    : process.env.OPENAI_API_KEY
      ? "openai/gpt-5.5"
      : "mock/echo";
  writeFileSync(profile, [
    `model = "${defaultModel}"`,
    `model_provider = "omnicodex"`,
    `model_catalog_json = ${tomlLiteral(catalog)}`,
    "",
    "[model_providers.omnicodex]",
    `name = "OmniCodex Gateway"`,
    `base_url = "http://${config.host}:${config.port}/v1"`,
    `wire_api = "responses"`,
    `supports_websockets = false`,
    `requires_openai_auth = ${oauth}`,
    ""
  ].join("\n"));
  console.log(`Installed profile: ${profile}`);
  console.log("Launch with: codex --profile omnicodex");
}

function uninstallCodex(): void {
  const profile = profilePath();
  const backup = `${profile}.bak`;
  if (existsSync(profile)) rmSync(profile);
  if (existsSync(backup)) renameSync(backup, profile);
  console.log(`Removed OmniCodex profile: ${profile}`);
}

if (command === "serve") {
  // Gateway on configured port
  const gateway = createGatewayServer(config);
  gateway.listen(config.port, config.host, () => {
    console.log(`OmniCodex Gateway → http://${config.host}:${config.port}`);
  });

  // Admin dashboard on next port
  const adminPort = config.port + 1;
  const admin = createAdminServer(config);
  admin.listen(adminPort, config.host, () => {
    console.log(`OmniCodex Admin  → http://${config.host}:${adminPort}/admin`);
  });
} else if (command === "sync") {
  console.log(await syncProviders());
} else if (command === "providers") {
  console.table(registry.providers());
} else if (command === "models") {
  console.table(registry.models(process.argv[3]).map((model) => ({ id: model.id, protocol: model.provider.protocol })));
} else if (command === "doctor") {
  const codex = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "codex --version"], { encoding: "utf8" })
    : spawnSync("codex", ["--version"], { encoding: "utf8" });
  console.table({
    node: process.version,
    codex: codex.stdout?.trim() || "not found",
    providers: registry.providers().length,
    adapterProviders: registry.providers().filter((provider) => provider.configured).length,
    credentialReady: registry.providers().filter((provider) => provider.credentialReady).length,
    models: registry.models().length,
    host: config.host,
    port: config.port,
    adminPort: config.port + 1
  });
} else if (command === "codex" && process.argv[3] === "install") {
  installCodex();
} else if (command === "codex" && process.argv[3] === "uninstall") {
  uninstallCodex();
} else {
  console.error("Usage: omnicodex serve|sync|providers|models [provider]|doctor|codex install|codex uninstall");
  process.exitCode = 1;
}
