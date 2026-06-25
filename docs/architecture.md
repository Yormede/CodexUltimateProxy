# Architecture

Codex CLI sends Responses requests to the OmniCodex Gateway at `127.0.0.1:4141/v1/responses`.
The model id uses the `provider/model` format; the registry resolves it to a protocol adapter and upstream credential.

## Adapters

- `responses` — byte-for-byte SSE pass-through with rewritten model id (for native OpenAI Responses providers)
- `openai-compatible` — Responses → Chat Completions request translation, SSE → Responses event stream
- `anthropic` — Responses → Anthropic Messages translation
- `google` — Responses → Google Gemini (API-key) translation
- `google-vertex` — Responses → Google Vertex AI translation (with JWT token exchange)
- `azure` — Responses → Azure OpenAI Chat Completions translation
- `bedrock` — Responses → AWS Bedrock InvokeModelWithResponseStream (with SigV4 signing)
- `mock` — deterministic contract testing, tool round-trip verification

## Key components

```
src/
├── server.ts       # Gateway HTTP server (port 4141)
├── admin.ts        # Admin API + dashboard backend (port 4142)
├── cli.ts          # CLI entrypoint (serve, sync, doctor, codex install)
├── config.ts       # TOML/JSON config + ${ENV} expansion
├── registry.ts     # Provider/model resolution
├── responses.ts    # Protocol adapters + toChatRequest translation
└── ...

public/
└── index.html      # Single-file admin SPA (~41 KB)

data/
└── providers.snapshot.json  # 144-provider open-source registry
```

## Request flow

```
Codex → :4141/v1/responses {model: "deepseek/deepseek-v4-pro", ...}
  → Registry.resolve("deepseek/deepseek-v4-pro")
  → Provider "deepseek", protocol "openai-compatible"
  → chatResponses() → toChatRequest(body, "deepseek-v4-pro")
  → POST https://api.deepseek.com/chat/completions
  → processChatStream() → SSE → Codex
```

## Thinking / reasoning flow

- Codex sends `thinking: { type: "enabled" }` → forwarded to DeepSeek upstream
- Codex sends no thinking → `thinking: { type: "disabled" }` + reasoning_content stripped from history
- Live reasoning_content from stream is cached per content hash and injected back into future assistant messages