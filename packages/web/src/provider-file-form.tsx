import { useEffect, useState, type FormEvent } from "react";
import type { BaiClient } from "@bai/api/client";
import type { AdapterName, ProviderCapability, ProviderFile, ProviderFileInfo } from "@bai/shared";
import { Button, Checkbox, Field, Modal, Select, TextInput, Textarea } from "./components";

const ADAPTER_OPTIONS: { value: AdapterName; label: string }[] = [
  { value: "openai-compatible", label: "OpenAI-compatible (chat completions)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "responses", label: "OpenAI Responses" },
];

const CAPABILITIES: { value: ProviderCapability; label: string }[] = [
  { value: "text", label: "Chat (text)" },
  { value: "image", label: "Image generation" },
  { value: "video", label: "Video (coming soon)" },
];

/** Starter JSON for a new image block, per template. */
function imageStarter(template: "openai-images" | "generic"): string {
  const models = `[ { "id": "my-model", "modes": ["t2i"], "maxReferences": 0, "maxCount": 1 } ]`;
  if (template === "openai-images") {
    return JSON.stringify(
      { template: "openai-images", defaultModel: "my-model", models: JSON.parse(models), edit: "none" },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      template: "generic",
      defaultModel: "my-model",
      models: JSON.parse(models),
      generate: { method: "POST", path: "/v1/generate", contentType: "json", body: { prompt: "$prompt", model: "$model" } },
      response: { images: "data[*]", base64: "b64_json", mime: "media_type" },
    },
    null,
    2,
  );
}

/** Parse `KEY: VALUE` / `KEY=VALUE` lines into a header map. */
function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^([^:=]+)[:=](.*)$/.exec(trimmed);
    if (match === null) continue;
    out[match[1]!.trim()] = match[2]!.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function csv(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Create/edit a file-defined provider (`~/.config/bai/providers/<id>.json`).
 * Capability checkboxes drive which blocks are sent; the image block is edited
 * as JSON (the generic mapping is inherently structured).
 */
export function ProviderFileModal({
  client,
  existing,
  onClose,
  onSaved,
  onNotice,
}: {
  client: BaiClient;
  /** Existing provider file to edit; absent → create. */
  existing?: ProviderFileInfo;
  onClose: () => void;
  onSaved: () => void;
  onNotice: (message: string, kind?: "success" | "error") => void;
}) {
  const editing = existing !== undefined;
  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [providerType, setProviderType] = useState<ProviderCapability[]>(existing?.providerType ?? ["image"]);
  const [baseUrl, setBaseUrl] = useState("");
  const [env, setEnv] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [authHeader, setAuthHeader] = useState("authorization");
  const [authScheme, setAuthScheme] = useState("Bearer");
  const [adapter, setAdapter] = useState<AdapterName>("openai-compatible");
  const [textModels, setTextModels] = useState("");
  const [contextLength, setContextLength] = useState("");
  const [imageTemplate, setImageTemplate] = useState<"openai-images" | "generic">("openai-images");
  const [imageJson, setImageJson] = useState(imageStarter("openai-images"));
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit: load the full definition (list rows carry no secrets/mapping).
  useEffect(() => {
    if (existing === undefined) return;
    let cancelled = false;
    void client
      .providerFile(existing.id)
      .then(({ file }) => {
        if (cancelled) return;
        setName(file.name);
        setBaseUrl(file.baseUrl);
        setEnv((file.env ?? []).join(", "));
        setHeadersText(file.headers !== undefined ? Object.entries(file.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : "");
        setAuthHeader(file.auth?.header ?? "authorization");
        setAuthScheme(file.auth?.scheme ?? "Bearer");
        if (file.text !== undefined) {
          setAdapter(file.text.adapter);
          setTextModels(file.text.models.join(", "));
          setContextLength(file.text.contextLength !== undefined ? String(file.text.contextLength) : "");
        }
        if (file.image !== undefined) {
          setImageTemplate(file.image.template);
          setImageJson(JSON.stringify(file.image, null, 2));
        }
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, existing]);

  const toggleCapability = (cap: ProviderCapability, on: boolean): void => {
    setProviderType((current) => (on ? [...new Set([...current, cap])] : current.filter((c) => c !== cap)));
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const providerId = id.trim().toLowerCase();
    if (providerId.length === 0) return setError("Provider id is required");
    if (name.trim().length === 0) return setError("Display name is required");
    if (baseUrl.trim().length === 0) return setError("Base URL is required");
    if (providerType.length === 0) return setError("Select at least one capability");
    const ctx = contextLength.trim().length > 0 ? Number(contextLength) : undefined;
    if (ctx !== undefined && (!Number.isFinite(ctx) || ctx <= 0)) return setError("Context length must be a positive number");

    let image: unknown;
    if (providerType.includes("image")) {
      try {
        image = JSON.parse(imageJson);
      } catch (err) {
        return setError(`Image block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const parsedHeaders = parseHeaders(headersText);
    const body = {
      name: name.trim(),
      providerType,
      baseUrl: baseUrl.trim(),
      ...(csv(env).length > 0 ? { env: csv(env) } : {}),
      ...(parsedHeaders !== undefined ? { headers: parsedHeaders } : {}),
      ...(authHeader.trim().length > 0 || authScheme.trim().length > 0
        ? { auth: { header: authHeader.trim() || "authorization", scheme: authScheme.trim() } }
        : {}),
      ...(providerType.includes("text")
        ? {
            text: {
              adapter,
              models: csv(textModels),
              ...(ctx !== undefined ? { contextLength: ctx } : {}),
            },
          }
        : {}),
      ...(providerType.includes("image") ? { image } : {}),
    };
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await client.putProviderFile(providerId, body as unknown as ProviderFile);
        onNotice(editing ? `Updated provider ${providerId}` : `Added provider ${providerId}`);
        onSaved();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const remove = (): void => {
    if (existing === undefined) return;
    void (async () => {
      setBusy(true);
      try {
        await client.deleteProviderFile(existing.id);
        onNotice(`Removed provider ${existing.id}`);
        onSaved();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit ${existing?.name ?? existing?.id}` : "Add provider file"}
      size="lg"
      footer={
        <>
          {editing && (
            <Button variant="danger" onClick={remove} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="primary" onClick={submit} disabled={busy || loading}>
            {editing ? "Save" : "Add provider"}
          </Button>
        </>
      }
    >
      <form className="form-grid" onSubmit={submit}>
        <Field label="Provider id" hint="lowercase slug; the filename stem">
          <TextInput value={id} placeholder="my-flux" disabled={editing} onChange={(e) => setId(e.target.value)} />
        </Field>
        <Field label="Display name">
          <TextInput value={name} placeholder="My FLUX" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Base URL">
          <TextInput value={baseUrl} placeholder="https://gateway.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="Capabilities" hint="where it appears">
          <div className="checkbox-group">
            {CAPABILITIES.map((cap) => (
              <Checkbox
                key={cap.value}
                label={cap.label}
                checked={providerType.includes(cap.value)}
                onChange={(e) => toggleCapability(cap.value, e.target.checked)}
              />
            ))}
          </div>
        </Field>
        <Field label="Env vars" hint="comma-separated; the key can also be saved in the Providers card">
          <TextInput value={env} placeholder="MY_FLUX_API_KEY" onChange={(e) => setEnv(e.target.value)} />
        </Field>
        <Field label="Extra headers" hint="one KEY: VALUE per line (optional)">
          <Textarea value={headersText} mono rows={2} onChange={(e) => setHeadersText(e.target.value)} />
        </Field>
        <Field label="Auth header">
          <TextInput value={authHeader} placeholder="authorization" onChange={(e) => setAuthHeader(e.target.value)} />
        </Field>
        <Field label="Auth scheme" hint="empty sends the key raw">
          <TextInput value={authScheme} placeholder="Bearer" onChange={(e) => setAuthScheme(e.target.value)} />
        </Field>

        {providerType.includes("text") && (
          <>
            <Field label="Chat adapter">
              <Select options={ADAPTER_OPTIONS} value={adapter} onChange={(v) => setAdapter(v as AdapterName)} ariaLabel="Chat adapter" />
            </Field>
            <Field label="Chat models" hint="comma-separated ids">
              <TextInput value={textModels} placeholder="my-model-large, my-model-small" onChange={(e) => setTextModels(e.target.value)} />
            </Field>
            <Field label="Context length" hint="tokens (optional)">
              <TextInput value={contextLength} inputMode="numeric" placeholder="200000" onChange={(e) => setContextLength(e.target.value)} />
            </Field>
          </>
        )}

        {providerType.includes("image") && (
          <>
            <Field label="Image template">
              <Select
                options={[
                  { value: "openai-images", label: "OpenAI Images (compatible)" },
                  { value: "generic", label: "Generic (request/response mapping)" },
                ]}
                value={imageTemplate}
                onChange={(v) => {
                  const template = v === "generic" ? "generic" : "openai-images";
                  setImageTemplate(template);
                  setImageJson(imageStarter(template));
                }}
                ariaLabel="Image template"
              />
            </Field>
            <Field label="Image block (JSON)" hint="models, params, and the generic mapping">
              <Textarea value={imageJson} mono rows={12} onChange={(e) => setImageJson(e.target.value)} />
            </Field>
          </>
        )}

        {error !== null && <p className="error">{error}</p>}
      </form>
    </Modal>
  );
}
