# Audit baseline

Audit date: 2026-06-22

- Codex CLI installed: `0.141.0`
- Codex source commit: `21d36296f137c0954df24ea86abe9619318915e6`
- OpenCode source commit: `cf31029350820c6bfc0fbd0e052a79a067ee6116`
- OpenCode package version: `1.17.9`
- Models.dev snapshot: 144 providers and 5,289 models
- Node.js: `24.15.0`
- Bun: `1.3.14`

Codex source confirms custom providers accept only `wire_api = "responses"`. The gateway therefore
owns translation to Chat Completions, Anthropic Messages and Gemini.

OpenCode was used to identify provider families, auth exceptions and Models.dev integration. No
OpenCode code is copied into this repository.
