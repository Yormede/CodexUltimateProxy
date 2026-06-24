# Project DevLog: OmniCodexGateway
* **Date**: 2026-06-22
* **Tags**: `#OmniCodexGateway` `#DevLog`

---

> **Progress Summary**
> Construction et validation d'un gateway Responses unique permettant a Codex de router GPT OAuth, DeepSeek, Anthropic, Gemini et des modeles locaux/personnalises.

### Execution Details & Changes
* **Git Commits**: aucun commit ; depot Git initialise.
* **Core File Modifications**:
  * `src/`: serveur HTTP, registre, configuration, CLI et adaptateurs de protocoles.
  * `scripts/`: synchronisation Models.dev et generation du catalogue Codex.
  * `test/gateway.test.ts`: sept tests de contrat et d'isolation des credentials.
  * `docs/`: architecture, securite, audit, statut, setup Codex, providers personnalises et modeles locaux.
  * `data/providers.snapshot.json`: snapshot de 144 providers et 5 289 modeles.
  * `generated/codex-models.json`: catalogue Codex de 94 modeles utiles.
* **Technical Implementation**:
  * Provider Codex unique `omnicodex` expose sur `http://127.0.0.1:4141/v1`.
  * OAuth ChatGPT transmis uniquement a `https://chatgpt.com/backend-api/codex`.
  * Traduction Responses vers Chat Completions, Anthropic Messages et Gemini.
  * Streaming SSE, appels d'outils, resultats d'outils, usage et erreurs normalises.
  * Profil `C:\Users\AhmiSVG\.codex\omnicodex.config.toml` installe avec GPT-5.5 OAuth par defaut.
  * Test reel OAuth GPT-5.5 reussi avec reponse `OAUTH_PROXY_OK`.
  * Boucle outil Codex reelle reussie avec execution PowerShell et reponse `OMNICODEX_TOOL_OK`.

### Troubleshooting
> **Problem Encountered**: Codex n'accepte plus `wire_api = "chat"` et le catalogue refuse `apply_patch_tool_type = "function"`.
> **Solution**: gateway Responses unique avec traduction interne ; `apply_patch_tool_type` defini a `null` pour les modeles non natifs.

### Next Steps
- [ ] Ajouter les adaptateurs cloud natifs Vertex, Bedrock et Azure.
- [ ] Tester DeepSeek, Anthropic, Gemini, LM Studio et Ollama avec de vrais credentials/endpoints.
- [ ] Tester les fichiers Docker sur une machine disposant de Docker.

---

## Validation DeepSeek

> **Progress Summary**
> Integration DeepSeek V4 validee de bout en bout depuis Codex via OmniCodex Gateway.

### Execution Details & Changes
* **Core File Modifications**:
  * `scripts/sync-providers.ts`: catalogue DeepSeek limite aux modeles actifs `deepseek-v4-pro` et `deepseek-v4-flash`.
  * `src/responses.ts`: conversion du role Responses `developer` vers le role Chat Completions `system`, compatible avec DeepSeek.
  * Catalogue et profil Codex regeneres et reinstalles.
* **Technical Implementation**:
  * Verification de l'API officielle `/models`: seuls V4 Pro et V4 Flash sont exposes.
  * Test direct du gateway avec V4 Flash reussi.
  * Test reel Codex avec `deepseek/deepseek-v4-flash` reussi et sortie `DEEPSEEK_CODEX_OK`.
  * Typecheck et sept tests automatises valides.

### Troubleshooting
> **Problem Encountered**: le gateway deja lance n'avait pas recu `DEEPSEEK_API_KEY` apres `setx`, puis DeepSeek refusait le role `developer` envoye par Codex.
> **Solution**: redemarrage du gateway avec l'environnement utilisateur recharge et normalisation de `developer` vers `system`.

### Next Steps
- [ ] Revoquer la cle DeepSeek exposee dans la conversation et la remplacer localement.
- [ ] Redemarrer le gateway apres rotation de la cle.
