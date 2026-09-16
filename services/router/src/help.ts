import { Hono } from "hono";
import type { RouterDeps } from "./deps";

/** Gateway endpoints documented by `/api/help` (kept in one place). */
const ENDPOINTS = [
  {
    method: "POST",
    path: "/v1/chat/completions",
    summary: "OpenAI-compatible chat routing",
    detail:
      "Routes to the saved provider/account/model. `model` is bai's `provider/model` id; the `x-bai-account` header selects a saved account. Set `stream:true` for SSE.",
  },
  {
    method: "GET",
    path: "/v1/models",
    summary: "Routable model catalog",
    detail: "Every model across connected providers, as a bai `provider/model` id.",
  },
  {
    method: "POST",
    path: "/v1/images/generations",
    summary: "Image generation routing",
    detail:
      "`model` may be `provider/model`; `x-bai-account` selects a saved account. Returns base64 images.",
  },
  {
    method: "GET",
    path: "/api/help",
    summary: "This page",
    detail: "Human-readable documentation for the router endpoints.",
  },
  {
    method: "GET",
    path: "/api/help/openapi.json",
    summary: "OpenAPI 3.1 document",
    detail: "Machine-readable description of the endpoints above.",
  },
] as const;

/**
 * `GET /api/help` (HTML) + `GET /api/help/openapi.json` (OpenAPI 3.1). Mounted
 * only by the standalone `bai --router` app.
 */
export function createRouterHelp(deps: RouterDeps): Hono {
  const app = new Hono();
  app.get("/api/help", async (c) => {
    const providers = await deps.router.providers().catch(() => []);
    return c.html(renderHelpPage(deps.version, providers));
  });
  app.get("/api/help/openapi.json", (c) => c.json(openApiDocument(deps.version)));
  return app;
}

interface HelpProvider {
  id: string;
  name: string;
  accounts?: Array<{ id: string; label: string; source: string }>;
  models?: Array<{ id: string }>;
}

export function renderHelpPage(version: string, providers: HelpProvider[]): string {
  const rows = ENDPOINTS.map(
    (e) => `<tr>
      <td><span class="method ${e.method.toLowerCase()}">${e.method}</span></td>
      <td><code>${escapeHtml(e.path)}</code></td>
      <td><strong>${escapeHtml(e.summary)}</strong><br><span class="muted">${escapeHtml(e.detail)}</span></td>
    </tr>`,
  ).join("\n");

  const providerRows =
    providers.length === 0
      ? `<p class="muted">No providers configured yet. Add credentials with <code>bai --web</code> → Settings → Providers.</p>`
      : providers
          .map((p) => {
            const accounts = (p.accounts ?? []).map((a) => `${escapeHtml(a.label)} <span class="muted">(${escapeHtml(a.id)})</span>`).join(", ") || "<span class='muted'>none</span>";
            const models = (p.models ?? []).length;
            return `<tr><td><code>${escapeHtml(p.id)}</code></td><td>${escapeHtml(p.name)}</td><td>${accounts}</td><td>${models}</td></tr>`;
          })
          .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>bai router — API help</title>
<style>
  :root { color-scheme: dark; --bg:#0b0e14; --panel:#141922; --border:#232b38; --fg:#e6ebf2; --muted:#8b97a8; --accent:#7aa2f7; --get:#4ade80; --post:#f7b955; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 900px; margin: 0 auto; padding: 48px 24px 80px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 40px 0 12px; }
  a { color: var(--accent); }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 13px; background: var(--panel); padding: 2px 6px; border-radius: 5px; }
  pre { background: var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; overflow:auto; }
  pre code { background:none; padding:0; }
  .muted { color: var(--muted); }
  table { width:100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); vertical-align: top; font-size:14px; }
  th { color: var(--muted); font-weight:600; font-size:12px; text-transform: uppercase; letter-spacing:.05em; }
  .method { display:inline-block; font-weight:700; font-size:12px; min-width:48px; text-align:center; padding:2px 6px; border-radius:5px; background:var(--panel); }
  .method.get { color: var(--get); }
  .method.post { color: var(--post); }
  .banner { display:flex; justify-content:space-between; align-items:baseline; gap:16px; border-bottom:1px solid var(--border); padding-bottom:18px; }
</style>
</head>
<body>
<main>
  <div class="banner">
    <div><h1>bai router</h1><div class="muted">OpenAI-compatible inference gateway · v${escapeHtml(version)}</div></div>
    <div><a href="/api/help/openapi.json">OpenAPI JSON →</a></div>
  </div>

  <h2>Authentication</h2>
  <p>Loopback requests need no token. When bound beyond loopback, send <code>Authorization: Bearer &lt;token&gt;</code>.</p>

  <h2>Endpoints</h2>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>Choosing a provider, account and model</h2>
  <p><code>model</code> uses bai's <code>provider/model</code> id (list them with <code>GET /v1/models</code>). Select a saved account with the <code>x-bai-account</code> header; omitted, the configured default is used.</p>

  <h2>Examples</h2>
  <pre><code>curl -N http://127.0.0.1:9640/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "x-bai-account: work" \\
  -d '{"model":"openai/gpt-5","stream":true,"messages":[{"role":"user","content":"hello"}]}'</code></pre>
  <pre><code>curl http://127.0.0.1:9640/v1/images/generations \\
  -H "Content-Type: application/json" \\
  -d '{"model":"openai/gpt-image-1","prompt":"a red panda","n":1,"size":"1024x1024"}'</code></pre>

  <h2>Saved providers</h2>
  <table>
    <thead><tr><th>Provider</th><th>Name</th><th>Accounts</th><th>Models</th></tr></thead>
    <tbody>${providerRows}</tbody>
  </table>
</main>
</body>
</html>`;
}

/** A minimal but valid OpenAPI 3.1 document for the router endpoints. */
export function openApiDocument(version: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "bai router", version, description: "OpenAI-compatible inference gateway over bai's saved providers, accounts and models." },
    servers: [{ url: "http://127.0.0.1:9640", description: "local router" }],
    paths: {
      "/v1/models": {
        get: {
          summary: "List routable models",
          operationId: "listModels",
          responses: { "200": { description: "Model list", content: { "application/json": { schema: { $ref: "#/components/schemas/ModelList" } } } } },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "Create a chat completion",
          operationId: "chatCompletions",
          parameters: [accountHeader()],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ChatCompletionRequest" } } } },
          responses: {
            "200": { description: "A completion, or an SSE stream when `stream:true`", content: { "application/json": { schema: { $ref: "#/components/schemas/ChatCompletion" } }, "text/event-stream": { schema: { type: "string" } } } },
            "400": { description: "Invalid request" },
            "502": { description: "Upstream provider error" },
          },
        },
      },
      "/v1/images/generations": {
        post: {
          summary: "Create an image",
          operationId: "generateImages",
          parameters: [accountHeader()],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ImageGenerationRequest" } } } },
          responses: {
            "200": { description: "Generated images (base64)", content: { "application/json": { schema: { $ref: "#/components/schemas/ImageGenerationResponse" } } } },
            "400": { description: "Invalid request" },
            "502": { description: "Upstream provider error" },
          },
        },
      },
      "/api/help": {
        get: { summary: "Router help page", operationId: "helpPage", responses: { "200": { description: "HTML documentation", content: { "text/html": { schema: { type: "string" } } } } } },
      },
      "/api/help/openapi.json": {
        get: { summary: "This OpenAPI document", operationId: "openapi", responses: { "200": { description: "OpenAPI 3.1 JSON", content: { "application/json": { schema: { type: "object" } } } } } },
      },
    },
    components: {
      parameters: {
        BaiAccount: {
          name: "x-bai-account",
          in: "header",
          required: false,
          description: "Saved account id to route with (defaults to the configured account).",
          schema: { type: "string" },
        },
      },
      schemas: {
        ChatMessage: {
          type: "object",
          required: ["role"],
          properties: {
            role: { type: "string", enum: ["system", "developer", "user", "assistant", "tool"] },
            content: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }, { type: "null" }] },
            tool_calls: { type: "array", items: { type: "object" } },
            tool_call_id: { type: "string" },
          },
        },
        ChatCompletionRequest: {
          type: "object",
          required: ["model", "messages"],
          properties: {
            model: { type: "string", description: "bai `provider/model` id" },
            messages: { type: "array", items: { $ref: "#/components/schemas/ChatMessage" } },
            tools: { type: "array", items: { type: "object" } },
            stream: { type: "boolean" },
            temperature: { type: "number" },
            top_p: { type: "number" },
            max_tokens: { type: "integer" },
            reasoning_effort: { type: "string" },
          },
        },
        ChatCompletion: {
          type: "object",
          properties: {
            id: { type: "string" },
            object: { type: "string", const: "chat.completion" },
            created: { type: "integer" },
            model: { type: "string" },
            choices: { type: "array", items: { type: "object" } },
            usage: { $ref: "#/components/schemas/Usage" },
          },
        },
        Usage: {
          type: "object",
          properties: { prompt_tokens: { type: "integer" }, completion_tokens: { type: "integer" }, total_tokens: { type: "integer" } },
        },
        Model: { type: "object", properties: { id: { type: "string" }, object: { type: "string" }, created: { type: "integer" }, owned_by: { type: "string" } } },
        ModelList: { type: "object", properties: { object: { type: "string", const: "list" }, data: { type: "array", items: { $ref: "#/components/schemas/Model" } } } },
        ImageGenerationRequest: {
          type: "object",
          required: ["prompt"],
          properties: {
            model: { type: "string", description: "bai `provider/model` id" },
            prompt: { type: "string" },
            n: { type: "integer" },
            size: { type: "string" },
            response_format: { type: "string" },
          },
        },
        ImageGenerationResponse: {
          type: "object",
          properties: {
            created: { type: "integer" },
            model: { type: "string" },
            data: { type: "array", items: { type: "object", properties: { b64_json: { type: "string" }, mime_type: { type: "string" } } } },
          },
        },
      },
    },
  };
}

function accountHeader(): { $ref: string } {
  return { $ref: "#/components/parameters/BaiAccount" };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
