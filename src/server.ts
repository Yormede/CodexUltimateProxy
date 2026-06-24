import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "./config.ts";
import { Registry } from "./registry.ts";
import { anthropicResponses, chatResponses, googleResponses, mockResponses, nativeResponses, googleVertexResponses, azureResponses, bedrockResponses } from "./responses.ts";

const MAX_BODY = 5 * 1024 * 1024;

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY) throw new Error("Request body exceeds 5 MiB");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function createGatewayServer(config: GatewayConfig): Server {
  const registry = new Registry(config);
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" });
      if (req.method === "GET" && url.pathname === "/ready") {
        return json(res, 200, { status: "ready", executableProviders: registry.providers().filter((p) => p.configured).length });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, {
          object: "list",
          data: registry.models().map((model) => ({
            id: model.id,
            object: "model",
            owned_by: model.providerId
          }))
        });
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        return json(res, 404, { error: { message: "Not found", type: "not_found" } });
      }
      const input = await body(req);
      if (typeof input.model !== "string") throw new Error("model is required");
      const model = registry.resolve(input.model);
      console.log(JSON.stringify({ requestId, provider: model.providerId, model: model.upstreamModel, event: "request" }));
      if (model.provider.protocol === "mock") return mockResponses(res, model, input);
      if (model.provider.protocol === "responses") return await nativeResponses(req, res, model, input);
      if (model.provider.protocol === "openai-compatible") return await chatResponses(req, res, model, input);
      if (model.provider.protocol === "anthropic") return await anthropicResponses(req, res, model, input);
      if (model.provider.protocol === "google") return await googleResponses(req, res, model, input);
      if (model.provider.protocol === "google-vertex") return await googleVertexResponses(req, res, model, input);
      if (model.provider.protocol === "azure") return await azureResponses(req, res, model, input);
      if (model.provider.protocol === "bedrock") return await bedrockResponses(req, res, model, input);
      throw new Error(`Protocol not implemented: ${model.provider.protocol}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(JSON.stringify({ requestId, event: "error", message, durationMs: Date.now() - started }));
      if (!res.headersSent) {
        json(res, message.includes("not executable") || message.includes("namespaced") ? 400 : 502, {
          error: { message, type: "gateway_error", request_id: requestId }
        });
      } else {
        res.end();
      }
    }
  });
}
