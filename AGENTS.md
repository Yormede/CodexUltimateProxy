# OmniCodex Gateway — Agent Instructions

You are contributing to OmniCodex Gateway, a multi-provider LLM proxy with a built-in admin dashboard.

## REGLE OBLIGATOIRE — Architecture Obsidian

**AVANT toute modification de code :**
1. Lire `C:\Users\AhmiSVG\Documents\ObsidianVault\OmniCodex\ARCHITECTURE.md` pour reprendre le contexte complet
2. Effectuer les modifications
3. **Mettre a jour** `C:\Users\AhmiSVG\Documents\ObsidianVault\OmniCodex\ARCHITECTURE.md` : ajouter la date dans "Historique modifications", mettre a jour l'etat des features concernees, corriger tout detail architectural impacte

Cette regle s'applique a chaque session, meme courte.

## Workflow de developpement

- **OmniCodexGateway** = depot de travail (on modifie, on teste ici)
- **OmniCodexStable** = production (NE PAS TOUCHER a la main)
- Promotion : `scripts/promote-to-stable.ps1` (tests + backup + git commit auto)

## Architecture

```
src/
├── cli.ts            # Entrypoint, routes commands (serve/sync/doctor/codex install/oauth)
├── config.ts         # GatewayConfig loader, 13 provider defaults, validation
├── registry.ts       # Snapshot catalog (models.dev) + live provider resolution (hot reload)
├── server.ts         # Gateway HTTP server port 4141
├── admin.ts          # Admin REST API + UI server port 4142 (port = gateway+1)
├── responses.ts      # Protocol translators (1256 lignes): 8 adaptateurs
├── messages.ts       # Anthropic Messages <-> Responses SSE bridge (/v1/messages)
├── sessions.ts       # Conversations reader (~/.codex/sessions JSONL)
├── credentials.ts    # Google Vertex ADC chain + AWS SigV4
└── oauth.ts          # OAuth 2.0 Device Flow generique (RFC 8628)
public/
└── index.html        # Admin SPA (vanilla JS, 46 Ko, aucun framework)
scripts/
├── promote-to-stable.ps1      # Promotion Gateway -> Stable
├── sync-providers.ts          # Fetch models.dev -> data/providers.snapshot.json
└── generate-codex-catalog.ts  # Build generated/codex-models.json
test/
├── gateway.test.ts   # 19 tests integration HTTP
└── adapters.test.ts  # Tests unitaires traducteurs
data/
└── providers.snapshot.json    # Catalogue models.dev (npm run sync)
generated/
└── codex-models.json          # Catalogue Codex filtre (npm run catalog)
```

## 8 protocoles supportes (responses.ts)

| Protocol | Adaptateur | Upstream format |
|---|---|---|
| mock | mockResponses() | — synthetique |
| responses | nativeResponses() | OpenAI Responses passthrough |
| openai-compatible | chatResponses() + processChatStream() | Chat Completions SSE |
| anthropic | anthropicResponses() + consumeAnthropicEvent() | Anthropic Messages SSE |
| google | googleResponses() + processGoogleStream() | Google generateContent SSE |
| google-vertex | googleVertexResponses() + processGoogleStream() | idem google |
| azure | azureResponses() + processChatStream() | Chat Completions (deployment URL) |
| bedrock | bedrockResponses() + parseEventStream() | Anthropic Bedrock binary frames |

## Adding a new provider

1. `src/config.ts` — ajouter dans `defaults.providers`
2. `src/admin.ts` — ajouter dans `PROVIDER_META` + `BUILTIN_IDS` si built-in
3. Si protocole non standard : traducteur dans `src/responses.ts` + case dans `dispatch()` de `server.ts`
4. `npm test && npm run typecheck`

## Modifying the admin UI

The admin UI is a single `public/index.html`. It uses vanilla JS with fetch calls to `/api/*`. No build step, no framework.

- Provider cards: rendered from `GET /api/providers`
- Model selection: checkboxes saved via `POST /api/models/selections`
- Profile switch: `POST /api/profile/switch { target: "default" | "omnicodex" }`

## Key files

| File | Purpose |
|---|---|
| `src/config.ts` | Default gateway providers, Protocol types |
| `src/registry.ts` | Hot-reload provider resolution (relit config a chaque requete) |
| `src/admin.ts` | CRUD providers, cles, selections, profil Codex |
| `src/responses.ts` | Les 8 adaptateurs protocol + toChatRequest() cleanup tool_calls |
| `src/messages.ts` | Bridge /v1/messages Anthropic entrant |
| `data/providers.snapshot.json` | Full model catalog from models.dev |
| `generated/codex-models.json` | Filtered catalog Codex actually reads |
| `omnicodex.keys.json` | Key storage (gitignored, mirrored to .env) |
| `omnicodex.selections.json` | User model selections per provider |

## Build & Test

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test test/*.test.ts
npm start            # node src/cli.ts serve
```

All must pass before pushing or promoting to Stable.

## Security

- Admin server only binds to 127.0.0.1 by default.
- API keys stored in `omnicodex.keys.json` (gitignored).
- Never log full API keys.
- Gateway strips inbound `Authorization` before forwarding to non-OpenAI providers.
- `forwardAuthorization` only allowed for providers whose ID starts with "openai".

## Pieges critiques

- **toChatRequest() lignes 164-217** : nettoyage tool_calls incomplets. NE PAS MODIFIER sans tests.
- **Registry hot-reload** : `loadConfigProviders()` relit le JSON a chaque appel. C'est voulu.
- **Port admin = gateway+1** : hardcode dans cli.ts.
- **BUILTIN_IDS** : les built-ins ne peuvent pas etre supprimes, seulement desactives.
