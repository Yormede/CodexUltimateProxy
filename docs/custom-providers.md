# Custom providers

Add an OpenAI-compatible provider to `omnicodex.config.json`:

```json
{
  "providers": {
    "company": {
      "protocol": "openai-compatible",
      "baseURL": "https://llm.example.com/v1",
      "keyEnv": "COMPANY_LLM_KEY",
      "models": {
        "code-large": {
          "name": "Company Code Large",
          "context": 131072,
          "output": 16384,
          "tools": true
        }
      }
    }
  }
}
```

Select it with `company/code-large`.
