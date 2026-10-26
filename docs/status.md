# Implementation status

## Verified live

- Codex 0.142.0 → OmniCodex Responses streaming with `deepseek/deepseek-v4-pro`.
- DeepSeek thinking mode — respects Codex `reasoning effort: high`, forwards to upstream.
- ChatGPT OAuth pass-through to official Codex backend using GPT-5.5.
- Complete Codex tool call round-trips (mock + live DeepSeek).
- Custom model catalog with 92 coding-capable routes, per-provider selections.
- Admin dashboard: dashboard, providers, models (search + group + select/deselect), playground, profile, logs, restart.
- Registry import from 144-provider open-source snapshot.

## Verified by contract tests (12 pass, 0 fail)

- OpenAI-compatible Chat Completions → Responses translation (DeepSeek auth isolation).
- Anthropic Messages → Responses translation (streaming, tool use).
- Google Gemini → Responses translation (API-key streaming).
- Google Vertex → Responses translation (token/auth handling).
- Azure OpenAI → Responses translation (Chat Completions streaming).
- AWS Bedrock → Responses translation (InvokeModelWithResponseStream, SigV4 signing).
- Groups consecutive function calls into one assistant tool_calls block.
- Disables DeepSeek thinking mode when not requested + strips reasoning_content.
- Rejects ambiguous model ids (missing provider/ prefix).

## Admin UI

- Dashboard: active profile, model, provider, configured keys, catalog size, uptime, per-provider breakdown.
- Providers: key management, test connection, add custom provider, import from 144-provider registry.
- Models: search by name/provider, grouped by provider, Select All / Deselect All per provider, count badges.
- Playground: send test prompts to any catalog model, display streaming responses.
- Profile: switch profiles, download config.toml.
- Logs: live SSE stream + recent log buffer.
- Restart: restart gateway from dashboard with auto-reconnect.

## Discovered, not claimed operational

- Additional cloud adapters: Vertex ADC, Bedrock credential chains, GitLab, Cohere, Vercel AI Gateway.
- OAuth/device flows beyond existing Codex/ChatGPT OAuth.
- Live credentials for Anthropic, Google Gemini, Azure, Bedrock, Vertex.

## Environment

- DeepSeek API key configured and verified.
- OpenRouter API key configured and verified.
- LM Studio and Ollama not tested locally.
- Docker deployment not executed (Docker not installed on this machine).
## v0.2 — Full CRUD, history recovery, Claude Code (2026-07-02)

### Providers — unified & persistent
- Admin now manages the SAME provider set the gateway uses (config defaults + omnicodex.config.json + 144-provider registry) instead of 5 hard-coded entries.
- Create / edit (baseURL, protocol, key env) / enable-disable / delete all persist to `omnicodex.config.json` and are picked up live (registry resolves the config path per call; provider edits merge over defaults).
- Registry import persists to config. Built-ins are disabled rather than deleted.
- API keys map to each provider's real gateway env var (fixed google→GEMINI_API_KEY class of mismatch) and go live in-process on save (no restart needed for keys).

### Playground / testing
- Playground routes through the gateway `/v1/responses`, so every protocol (responses, openai-compatible, anthropic, google, vertex, azure, bedrock, mock) is exercised from the UI — not just openai-compatible.
- Test-connection is protocol-aware (Bearer / x-api-key / x-goog-api-key).

### Downloads / observe
- Download endpoints for config.toml, `codex-models.json`, and `omnicodex.config.json`.
- Live Logs page now receives real gateway output (console is teed into the ring buffer).

### Conversation history (all profiles)
- `src/sessions.ts` parses Codex rollout JSONL under `~/.codex/sessions` (schema-tolerant), aggregated across every profile.
- Admin API: `GET /api/conversations`, `GET /api/conversations/:id`, `GET /api/conversations/:id/download`; new Conversations page to browse and read them.

### Claude Code (inbound Anthropic API)
- Gateway exposes `POST /v1/messages` (Anthropic Messages wire protocol). Claude Code can point at OmniCodex and route to ANY provider.
- Inbound Anthropic request → internal Responses body → existing adapters (captured in-memory) → Anthropic JSON or SSE back. Supports text + tool_use.

### Fixes
- Reasoning cache no longer crashes when `~/.codex` is absent (mkdir -p).
- Registry config path resolves live (was cached at import).

### Tests
- 19/19 contract tests pass (`npm test`), `tsc --noEmit` clean. New coverage: `/v1/messages` (JSON + stream + tool_use), Anthropic↔Responses translation, conversation parsing, admin provider CRUD persistence.

## v0.3 — Streaming + previously-"discovered" adapters now operational (2026-07-02)

### Incremental streaming for /v1/messages (Claude Code)
- Real-time translator (`AnthropicSSETranslator`): provider Responses SSE is parsed as it arrives and re-emitted as Anthropic `message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop`, token by token (no buffering). Text and tool_use both stream. Contract-tested (one `text_delta` per upstream chunk).

### Moved from "discovered" to operational (code + unit tests; live validation still needs your creds)
- **Google Vertex ADC** (`src/credentials.ts`): explicit token → `GOOGLE_APPLICATION_CREDENTIALS` service account → ADC well-known file (`application_default_credentials.json`, both `authorized_user` refresh and `service_account`) → GCE/Cloud Run metadata server → `gcloud` CLI.
- **AWS Bedrock credential chain**: env keys → `~/.aws/credentials` profile (`AWS_PROFILE` / `AWS_SHARED_CREDENTIALS_FILE`) → bearer token. INI profile parser unit-tested.
- **Cohere**, **Vercel AI Gateway**, **GitLab Duo** added as first-class providers (Cohere/Vercel via their OpenAI-compatible endpoints; GitLab present but disabled until you set your instance base URL).
- **OAuth device flow (RFC 8628)** (`src/oauth.ts` + `omnicodex oauth <provider>`): config-driven device authorization + polling (handles `authorization_pending`/`slow_down`), token stored to the provider's key env. Beyond the existing Codex/ChatGPT OAuth. Core unit-tested with an injected fetch.

### Still genuinely not verified live (needs your machine)
- Live calls to Anthropic / Gemini / Azure / Bedrock / Vertex / Cohere / Vercel / GitLab — the sandbox has no network and no keys for these. Run `npm start` and test from the dashboard.
- GitLab base URL is a placeholder; set it to your AI-gateway endpoint before enabling.
- Device flow endpoints/client IDs are provider-specific — supply via the `OMNICODEX_OAUTH_*` env vars.

### Tests
- 23/23 contract + unit tests pass; `tsc --noEmit` clean. `doctor`: 147 providers, 134 adapter-ready, 4872 models.
