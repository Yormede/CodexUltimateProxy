# Architecture

Codex sends Responses requests to one local gateway. The model id uses `provider/model`; the
registry resolves it to a protocol adapter and upstream credential.

The first vertical slice has three adapters:

- `responses`: byte-for-byte SSE pass-through with a rewritten model id;
- `openai-compatible`: Responses request to Chat Completions request and SSE back to Responses;
- `mock`: deterministic contract testing.

Models.dev is metadata, not proof of runtime compatibility. The generated parity report separates
discovery from executable adapters.
