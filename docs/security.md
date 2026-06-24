# Security

- The server binds to localhost by default.
- Remote binding requires `OMNICODEX_ALLOW_REMOTE=1` and should be placed behind HTTPS.
- Inbound `Authorization` is discarded for every non-OpenAI route.
- Upstream keys come from provider-specific environment variables.
- Redirects are refused to prevent credentials crossing hosts.
- Request bodies and secrets are not logged.
- Custom provider URLs must be HTTP(S) and cannot contain credentials.

ChatGPT OAuth is not an OpenAI Platform API key. It is forwarded only for the `openai-chatgpt`
provider to the Codex backend path used by Codex itself. The token and account id are never logged
or persisted by the gateway.
