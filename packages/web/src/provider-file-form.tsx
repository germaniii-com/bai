import { useEffect, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { AdapterName, ProviderCapability, ProviderFile, ProviderFileInfo } from "@bai/shared";
import { Button, Checkbox, Field, IconButton, Modal, Select, TextInput, Textarea } from "./components";
import { headerRowsFrom, headersFromRows, type HeaderRow } from "./provider-utils";

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

function csv(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Create/edit a file-defined provider (`~/.config/bai/providers/<id>.json`).
 * Same two-column form stance as the custom-provider modal: short labels,
 * full-width rows for the wide controls, and key/value header rows instead of
 * a free-text blob. Capability checkboxes drive which blocks are sent; the
 * image block is edited as JSON (the generic mapping is inherently structured).
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
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
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
        setHeaderRows(headerRowsFrom(file.headers));
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

  const setHeaderRow = (index: number, patch: Partial<HeaderRow>): void => {
    setHeaderRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const providerId = id.trim().toLowerCase();
    if (providerId.length === 0) return setError("Provider ID is required");
    if (name.trim().length === 0) return setError("Display Name is required");
    if (baseUrl.trim().length === 0) return setError("Base URL is required");
    if (providerType.length === 0) return setError("Select at least one capability");
    const ctx = contextLength.trim().length > 0 ? Number(contextLength) : undefined;
    if (ctx !== undefined && (!Number.isFinite(ctx) || ctx <= 0)) return setError("Context Length must be a positive number");

    let image: unknown;
    if (providerType.includes("image")) {
      try {
        image = JSON.parse(imageJson);
      } catch (err) {
        return setError(`Image Block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const parsedHeaders = headersFromRows(headerRows);
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
      <form className="stack-form" onSubmit={submit}>
        <div className="form-grid form-grid-2">
          <Field label="Display Name">
            <TextInput value={name} placeholder="My FLUX" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Provider ID">
            <TextInput value={id} placeholder="my-flux" disabled={editing} onChange={(e) => setId(e.target.value)} />
          </Field>
          <div className="field span-2">
            <span className="field-label">Base URL</span>
            <TextInput value={baseUrl} placeholder="https://gateway.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="field span-2">
            <span className="field-label">Capabilities</span>
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
          </div>
          <div className="field span-2">
            <span className="field-label">Env Vars</span>
            <TextInput value={env} placeholder="MY_FLUX_API_KEY" onChange={(e) => setEnv(e.target.value)} />
          </div>
          <Field label="Auth Header">
            <TextInput value={authHeader} placeholder="authorization" onChange={(e) => setAuthHeader(e.target.value)} />
          </Field>
          <Field label="Auth Scheme">
            <TextInput value={authScheme} placeholder="Bearer" onChange={(e) => setAuthScheme(e.target.value)} />
          </Field>
          <div className="field span-2">
            <span className="field-label">Extra Headers (optional)</span>
            {headerRows.length > 0 && (
              <div className="header-rows">
                {headerRows.map((row, i) => (
                  <div className="header-row" key={i}>
                    <TextInput
                      value={row.key}
                      placeholder="KEY"
                      aria-label={`Header ${i + 1} name`}
                      mono
                      onChange={(e) => setHeaderRow(i, { key: e.target.value })}
                    />
                    <TextInput
                      value={row.value}
                      placeholder="Value"
                      aria-label={`Header ${i + 1} value`}
                      mono
                      onChange={(e) => setHeaderRow(i, { value: e.target.value })}
                    />
                    <IconButton
                      label={row.key.trim().length > 0 ? `Remove header ${row.key.trim()}` : `Remove header row ${i + 1}`}
                      onClick={() => setHeaderRows((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X size={14} aria-hidden="true" />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Button variant="ghost" size="sm" onClick={() => setHeaderRows((prev) => [...prev, { key: "", value: "" }])}>
                <Plus size={14} aria-hidden="true" /> Add header
              </Button>
            </div>
          </div>

          {providerType.includes("text") && (
            <>
              <Field label="Chat Adapter">
                <Select options={ADAPTER_OPTIONS} value={adapter} onChange={(v) => setAdapter(v as AdapterName)} ariaLabel="Chat Adapter" />
              </Field>
              <Field label="Context Length (optional)">
                <TextInput value={contextLength} inputMode="numeric" placeholder="200000" onChange={(e) => setContextLength(e.target.value)} />
              </Field>
              <div className="field span-2">
                <span className="field-label">Chat Models</span>
                <TextInput value={textModels} placeholder="my-model-large, my-model-small" onChange={(e) => setTextModels(e.target.value)} />
              </div>
            </>
          )}

          {providerType.includes("image") && (
            <>
              <div className="field span-2">
                <span className="field-label">Image Template</span>
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
                  ariaLabel="Image Template"
                />
              </div>
              <div className="field span-2">
                <span className="field-label">Image Block (JSON)</span>
                <Textarea value={imageJson} mono rows={12} onChange={(e) => setImageJson(e.target.value)} />
              </div>
            </>
          )}
        </div>
        {error !== null && <p className="error">{error}</p>}
      </form>
    </Modal>
  );
}
