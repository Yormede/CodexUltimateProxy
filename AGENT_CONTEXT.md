# 專案上下文 (Agent Context)：OmniCodexGateway

> **最後更新時間**：2026-06-24 18:42
> **自動生成**：由 `prepare_context.py` 產生，供 AI Agent 快速掌握專案全局

---

## 🎯 1. 專案目標 (Project Goal)
* **核心目的**：One Codex Responses provider, routed to native Responses or OpenAI-compatible upstreams.
* _完整說明見 [README.md](README.md)_

## 🛠️ 2. 技術棧與環境 (Tech Stack & Environment)
* **開發套件**：@types/node, typescript
* **可用指令**：start, sync, doctor, catalog, test, typecheck

### 原始設定檔

<details><summary>package.json</summary>

```json
{
  "name": "omnicodex-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "bin": {
    "omnicodex": "./src/cli.ts"
  },
  "scripts": {
    "start": "node src/cli.ts serve",
    "sync": "node src/cli.ts sync",
    "doctor": "node src/cli.ts doctor",
    "catalog": "node scripts/generate-codex-catalog.ts",
    "test": "node --test test/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0"
  }
}

```
</details>

## 📂 3. 核心目錄結構 (Core Structure)
_(💡 AI 讀取守則：請依據此結構尋找對應檔案，勿盲目猜測路徑)_
```text
OmniCodexGateway/
├── 2026-06-22.md
├── AGENT_CONTEXT.md
├── Dockerfile
├── LICENSE
├── README.md
├── THIRD_PARTY_NOTICES.md
├── compose.yaml
├── config.example.json
├── data
│   └── providers.snapshot.json
├── diary
│   └── 2026
│       └── 06
├── docs
│   ├── architecture.md
│   ├── audit.md
│   ├── codex-setup.md
│   ├── custom-providers.md
│   ├── local-models.md
│   ├── provider-parity.md
│   ├── security.md
│   └── status.md
├── gateway.error.log
├── gateway.log
├── generated
│   └── codex-models.json
├── package-lock.json
├── package.json
├── scripts
│   ├── generate-codex-catalog.ts
│   └── sync-providers.ts
├── src
│   ├── cli.ts
│   ├── config.ts
│   ├── registry.ts
│   ├── responses.ts
│   └── server.ts
├── start.ps1
├── start.sh
├── test
│   └── gateway.test.ts
└── tsconfig.json
```

## 🏛️ 4. 架構與設計約定 (Architecture & Conventions)
* _（尚無 `.auto-skill-local.md`，專案踩坑經驗將在開發過程中自動累積）_

## 🚦 5. 目前進度與待辦 (Current Status & TODO)
_(自動提取自最近日記 2026-06-24)_

### 🚧 待辦事項
- [x] Ajouter les adaptateurs cloud natifs Vertex, Bedrock et Azure.
- [x] Corriger le bug de reasoning_content avec DeepSeek.
- [ ] Tester les fichiers Docker sur une machine disposant de Docker.

