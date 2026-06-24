# Codex setup

Generate a reversible Codex profile:

```powershell
node src/cli.ts codex install
codex --profile omnicodex -m mock/echo
```

Remove it:

```powershell
node src/cli.ts codex uninstall
```

The installer writes `~/.codex/omnicodex.config.toml` and preserves an existing file as `.bak`.
