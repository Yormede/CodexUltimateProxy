# OmniCodex Gateway

Multi-provider LLM proxy with built-in admin dashboard. Route Codex CLI through one unified API — OpenAI, DeepSeek, Anthropic, Google, Azure, Bedrock, and 144+ open-registry providers.

## Quick Start

```bash
git clone https://github.com/Yormede/CodexUltimateProxy.git
cd omnicodex-gateway
npm install          # Node.js >= 22
npm start            # Gateway :4141 + Admin :4142
```

- **Gateway API**: http://127.0.0.1:4141 (Responses endpoint at `/v1/responses`)
- **Admin Dashboard**: http://127.0.0.1:4142

## Features

- **Multi-provider routing** — OpenAI, DeepSeek, OpenRouter, Anthropic, Google Gemini, Azure, AWS Bedrock, Google Vertex, and any OpenAI-compatible endpoint
- **Built-in admin UI** — manage API keys, test connections, browse/search/select models, switch Codex profiles, restart gateway
- **Protocol translation** — auto-converts OpenAI Responses ↔ Chat Completions, Anthropic Messages, Google Gemini, Azure, Bedrock
- **Model catalog** — generates Codex-compatible `model_catalog_json`, with per-provider Select All / Deselect All and search
- **Profile switching** — switch between Codex default and OmniCodex proxy in one click from the dashboard
- **Registry import** — add providers from a 144-provider open-source registry in one click
- **Key management** — store and test API keys from the dashboard, synced to `.env`
- **Thinking/reasoning** — respects Codex reasoning effort settings, forwards DeepSeek thinking mode natively
- **Crash resilience** — uncaught exception/rejection handlers log fatal errors before exit

## Verified

- Codex `0.142.0` → OmniCodex Responses streaming with `deepseek/deepseek-v4-pro` (live)
- DeepSeek thinking mode with `reasoning effort: high`
- Codex tool call round-trips with `reasoning_content` caching
- ChatGPT OAuth pass-through to official Codex backend (GPT-5.5)
- Protocol adapters for Anthropic Messages, Google Gemini, Azure OpenAI, AWS Bedrock, Google Vertex (contract-tested)
- 12 test suite passes, 0 failures
- Admin UI: dashboard, providers, models, playground, profile, logs, restart

## Providers

| Provider | Protocol | Auth |
|---|---|---|
| DeepSeek | openai-compatible | API Key |
| OpenRouter | openai-compatible | API Key |
| OpenAI | responses / openai-compatible | API Key or OAuth |
| Anthropic | anthropic | API Key |
| Google Gemini | google | API Key |
| Google Vertex | google-vertex | ADC / token |
| Azure OpenAI | azure | API Key |
| AWS Bedrock | bedrock | IAM / bearer |
| +144 registry providers | openai-compatible / anthropic | API Key |

## Commands

```bash
npm start              # Start gateway + admin
npm run sync           # Refresh provider snapshot from models.dev
npm run catalog        # Regenerate Codex model catalog
npm run doctor         # Diagnostic report
npm test               # Run tests (12 pass)
npm run typecheck      # TypeScript check
```

## Configuration

Copy `config.example.json` to `omnicodex.config.json`:

```json
{
  "host": "127.0.0.1",
  "port": 4141,
  "providers": {
    "deepseek": {
      "protocol": "openai-compatible",
      "baseURL": "https://api.deepseek.com",
      "keyEnv": "DEEPSEEK_API_KEY"
    }
  }
}
```

Or add keys from the admin dashboard at http://127.0.0.1:4142 → Providers.

## Codex Integration

```bash
# Install Codex profile
npm start -- codex install

# Launch Codex with OmniCodex
codex --profile omnicodex

# Or switch profiles from the admin dashboard
open http://127.0.0.1:4142
```

The admin dashboard lets you:
1. Add API keys for each provider
2. Test connections and fetch available models
3. Browse models grouped by provider, search, Select All / Deselect All
4. Import providers from the 144-provider open-source registry
5. Switch between default and OmniCodex profiles
6. Send test prompts in the Playground
7. Watch live logs
8. Restart the gateway

## Architecture

```
Codex CLI → OmniCodex Gateway (:4141) → Registry → Protocol adapter → Upstream
                                              ↓
                                    Admin Dashboard (:4142)
```

- `src/responses.ts` — protocol adapters (Responses, Chat, Anthropic, Google, Azure, Bedrock, Vertex)
- `src/admin.ts` — admin API + UI backend (key management, model catalog, profile switching, restart)
- `src/registry.ts` — provider/model resolution from config + generated catalog
- `public/index.html` — single-file admin SPA
- `data/providers.snapshot.json` — 144-provider open-source registry

## License

MIT — see [LICENSE](LICENSE)