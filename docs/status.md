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