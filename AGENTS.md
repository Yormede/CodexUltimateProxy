# OmniCodex Gateway — Agent Instructions

You are contributing to OmniCodex Gateway, a multi-provider LLM proxy with a built-in admin dashboard.

## Architecture

```
src/
├── cli.ts            # Entrypoint, routes commands (serve/sync/doctor/codex install)
├── config.ts         # GatewayConfig loader, provider defaults, validation
├── registry.ts       # Snapshot model catalog (models.dev) + provider resolution
├── server.ts         # Main gateway HTTP server (port 4141 default)
├── admin.ts          # Admin REST API + UI server (port 4142 default)
├── responses.ts      # Protocol translators: OpenAI Responses ↔ Anthropic/Google/Azure/Bedrock/OpenAI-compatible
public/
├── index.html        # Admin dashboard SPA
scripts/
├── sync-providers.ts        # Fetch models.dev snapshot → data/providers.snapshot.json
├── generate-codex-catalog.ts # Build codex-models.json from snapshot + user selections
data/
├── providers.snapshot.json   # Auto-generated from sync
generated/
├── codex-models.json         # Codex-compatible model catalog
```

## Adding a new provider

1. Add to `PROVIDERS` in `src/admin.ts`:
   ```ts
   myprovider: {
     id: "myprovider", name: "My Provider", icon: "🧪",
     baseURL: "https://api.myprovider.com/v1", authHeader: "Bearer",
     color: "#ff0000", website: "https://myprovider.com",
   }
   ```

2. Add key mapping in `providerEnvKey()` (same file):
   ```ts
   myprovider: "MYPROVIDER_API_KEY"
   ```

3. Add to `src/config.ts` defaults if it needs a different protocol:
   ```ts
   myprovider: {
     protocol: "openai-compatible",
     baseURL: "https://api.myprovider.com/v1",
     keyEnv: "MYPROVIDER_API_KEY"
   }
   ```

4. If the protocol is not `openai-compatible`, add translation logic in `src/responses.ts`.

## Modifying the admin UI

The admin UI is a single `public/index.html`. It uses vanilla JS with fetch calls to `/api/*`. No build step, no framework.

- Provider cards: rendered from `GET /api/providers`
- Model selection: checkboxes saved via `POST /api/models/selections`
- Profile switch: `POST /api/profile/switch { target: "default" | "omnicodex" }`

## Key files

| File | Purpose |
|---|---|
| `src/config.ts` | Default gateway providers (openai, deepseek, anthropic, google, etc.) |
| `src/admin.ts` | Admin dashboard providers (deepseek, openrouter, groq, openai, opencode) |
| `data/providers.snapshot.json` | Full model catalog from models.dev |
| `generated/codex-models.json` | Filtered catalog Codex actually reads |
| `omnicodex.keys.json` | Encrypted-like key storage (keep gitignored) |
| `omnicodex.selections.json` | User model selections per provider |

## Build & Test

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test test/*.test.ts
npm start            # node src/cli.ts serve
```

All three must pass before pushing.

## Security

- Admin server only binds to 127.0.0.1 by default.
- API keys stored in `omnicodex.keys.json` (gitignored).
- Never log full API keys.
- Gateway strips inbound `Authorization` before forwarding to non-OpenAI providers.
