# Implementation status

## Verified live

- Codex 0.141.0 to OmniCodex Responses streaming.
- ChatGPT OAuth pass-through to the official Codex backend using GPT-5.5.
- Complete Codex tool round trip using the deterministic mock.
- Codex custom model catalog loading 94 coding-capable routes.

## Verified by contract tests

- OpenAI-compatible Chat Completions, including DeepSeek-style auth and streaming.
- Anthropic Messages streaming.
- Google Gemini API-key streaming.
- Credential isolation between providers.

## Discovered, not claimed operational

- Provider-specific AI SDK adapters such as Azure, Bedrock, GitLab, Cohere and Vercel AI Gateway.
- OAuth/device flows other than the existing Codex/ChatGPT OAuth.
- Vertex ADC and AWS credential chains.

## Environment blockers

- No `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` was present.
- LM Studio and Ollama were not listening locally.
- Docker was not installed, so the container files were not executed.
