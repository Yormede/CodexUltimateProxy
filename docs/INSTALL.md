# OmniCodex Gateway — Installation Guide

## Prerequisites

- **Node.js >= 22** (download from https://nodejs.org)
- **Git** (optional, for cloning)
- **npm** (bundled with Node.js)

> ⚠️ This guide is for **end users** who want to run OmniCodex.
> For AI agents: see [AGENTS.md](../AGENTS.md) for development instructions.

## Step 1: Clone or download

```bash
git clone https://github.com/YOUR_USER/omnicodex-gateway.git
cd omnicodex-gateway
```

Or download the ZIP from GitHub and extract it.

## Step 2: Install dependencies

```bash
npm install
```

## Step 3: Start the gateway

```bash
npm start
```

You should see:

```
OmniCodex Gateway → http://127.0.0.1:4141
OmniCodex Admin  → http://127.0.0.1:4142/admin
```

## Step 4: Configure API keys

Open **http://127.0.0.1:4142/admin** in your browser:

1. Go to **Providers & Keys**
2. Enter your API key for each provider (DeepSeek, OpenRouter, Groq, etc.)
3. Click **Save** then **Test** to verify the key works
4. Go to **Models** and click **Refresh** to fetch available models
5. Select the models you want to use, click **Save Selections**

## Step 5: Connect Codex (optional)

```bash
# From the gateway directory
npx tsx src/cli.ts codex install

# This creates ~/.codex/omnicodex.config.toml
```

Then launch Codex:

```bash
codex --profile omnicodex
```

To switch back to default:

```bash
codex --profile default
```

Or use the **Profile** page in the admin dashboard.

## Step 6: Test

Use the **Dashboard** page to verify everything is working:

- Gateway status: online
- Profile: omnicodex
- Configured providers: should show the ones you set up

## Troubleshooting

### "Cannot connect to gateway"

Make sure no other process is using ports 4141-4142:

```bash
# On Windows
netstat -ano | findstr "4141"
```

### "Provider test failed"

- Verify your API key is correct
- Check that the provider's website is accessible from your network
- Some providers require account verification before API access

### "tsx not found"

Run with `npx`:

```bash
npx tsx src/cli.ts serve
```

## Updating

```bash
git pull
npm install
npm start
```

The admin dashboard will preserve your API keys and model selections across updates.
