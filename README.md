# OmniCodex Gateway

Multi-provider LLM proxy with built-in admin dashboard. Route your AI coding tools through one unified API.

## Quick Start

```bash
# Clone
git clone https://github.com/YOUR_USER/omnicodex-gateway.git
cd omnicodex-gateway

# Install (Node.js >= 22)
npm install

# Start gateway + admin dashboard
npm start
```

- **Gateway API**: http://127.0.0.1:4141
- **Admin Dashboard**: http://127.0.0.1:4142/admin

## Features

- **Multi-provider routing**: OpenAI, DeepSeek, OpenRouter, Groq, Anthropic, Google, Azure, Bedrock, LM Studio, Ollama
- **Built-in admin UI**: Manage API keys, test connections, select models, switch Codex profiles
- **Protocol translation**: Auto-converts between OpenAI Responses, Anthropic Messages, Google Gemini, Azure, and AWS Bedrock
- **Model catalog**: Auto-syncs from models.dev, generates Codex-compatible `model_catalog_json`
- **Profile switching**: Switch between Codex default and OmniCodex proxy in one click
- **Key management**: Store and test API keys from the dashboard, synced to `.env`

## Providers

| Provider | Status | Auth |
|---|---|---|
| DeepSeek | Configured | API Key |
| OpenRouter | Configured | API Key |
| Groq | Configured | API Key |
| OpenAI | Configured | API Key or OAuth |
| OpenCode Go | Configured | API Key |
| Anthropic | Available | API Key |
| Google Gemini | Available | API Key |
| Azure OpenAI | Available | API Key |
| AWS Bedrock | Available | IAM |

## Commands

```bash
npm start              # Start gateway + admin
npm run sync           # Refresh provider snapshot from models.dev
npm run doctor         # Diagnostic report
npm test               # Run tests
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

Or use environment variables:

```bash
OMNICODEX_PORT=4141 DEEPSEEK_API_KEY=sk-... npm start
```

## Codex Integration

```bash
# Install Codex profile
npm start -- codex install

# Launch Codex with OmniCodex
codex --profile omnicodex

# Switch profiles from admin dashboard
open http://127.0.0.1:4142/admin
```

The admin dashboard lets you:
1. Add API keys for each provider
2. Test connections and fetch available models
3. Select which models appear in Codex's `/model` list
4. Switch between default and OmniCodex profiles

## License

MIT — see [LICENSE](LICENSE)
