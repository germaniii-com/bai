import { useState, type FormEvent } from "react";
import type { BaiClient } from "@bai/api/client";
import type { AdapterName, CustomProviderBody, ProviderInfo } from "@bai/shared";
import { Button, Field, Modal, Select, TextInput, Textarea } from "./components";

const ADAPTER_OPTIONS: { value: AdapterName; label: string }[] = [
  { value: "openai-compatible", label: "OpenAI-compatible (chat completions)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "responses", label: "OpenAI Responses" },
];

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

/**
 * Create/edit a config-defined custom provider. Writes the global config
 * layer; the server's config watcher invalidates the registry so the provider
 * is usable on the next message (no restart).
 */
export function CustomProviderModal({
  client,
  provider,
  onClose,
  onSaved,
  onNotice,
}: {
  client: BaiClient;
  /** Existing config provider to edit; absent → create. */
  provider?: ProviderInfo;
  onClose: () => void;
  onSaved: () => void;
  onNotice: (message: string, kind?: "success" | "error") => void;
}) {
  const editing = provider !== undefined;
  const [id, setId] = useState(provider?.id ?? "");
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [adapter, setAdapter] = useState<AdapterName>(provider?.adapter ?? "openai-compatible");
  const [keyEnv, setKeyEnv] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  const [contextLength, setContextLength] = useState("");
  const [headers, setHeaders] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const providerId = id.trim().toLowerCase();
    if (providerId.length === 0) {
      setError("Provider id is required");
      return;
    }
    if (baseUrl.trim().length === 0) {
      setError("Base URL is required");
      return;
    }
    const modelIds = models
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    const ctx = contextLength.trim().length > 0 ? Number(contextLength) : undefined;
    if (ctx !== undefined && (!Number.isFinite(ctx) || ctx <= 0)) {
      setError("Context length must be a positive number");
      return;
    }
    const parsedHeaders = parseHeaders(headers);
    const body: CustomProviderBody = {
      ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      baseUrl: baseUrl.trim(),
      adapter,
      ...(keyEnv.trim().length > 0 ? { apiKeyEnv: keyEnv.trim() } : {}),
      ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      ...(modelIds.length > 0 ? { models: modelIds } : {}),
      ...(parsedHeaders !== undefined ? { headers: parsedHeaders } : {}),
      ...(ctx !== undefined ? { contextLength: ctx } : {}),
    };
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await client.putCustomProvider(providerId, body);
        onNotice(editing ? `Updated ${providerId}` : `Added custom provider ${providerId}`);
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
      title={editing ? `Edit ${provider?.name ?? provider?.id}` : "Add custom provider"}
      size="md"
      footer={
        <Button variant="primary" onClick={submit} disabled={busy}>
          {editing ? "Save" : "Add provider"}
        </Button>
      }
    >
      <form className="form-grid" onSubmit={submit}>
        <Field label="Provider id" hint="lowercase slug, unique">
          <TextInput value={id} placeholder="my-gateway" disabled={editing} onChange={(e) => setId(e.target.value)} />
        </Field>
        <Field label="Display name">
          <TextInput value={name} placeholder="My Gateway" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Base URL">
          <TextInput value={baseUrl} placeholder="https://gateway.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="Wire adapter">
          <Select options={ADAPTER_OPTIONS} value={adapter} onChange={(v) => setAdapter(v as AdapterName)} ariaLabel="Wire adapter" />
        </Field>
        <Field label="API key env var" hint="preferred over an inline key">
          <TextInput value={keyEnv} placeholder="MY_GATEWAY_API_KEY" onChange={(e) => setKeyEnv(e.target.value)} />
        </Field>
        <Field label="API key" hint="stored in config.json; prefer an env var">
          <TextInput type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <Field label="Models" hint="comma-separated model ids">
          <TextInput value={models} placeholder="my-model-large, my-model-small" onChange={(e) => setModels(e.target.value)} />
        </Field>
        <Field label="Context length" hint="tokens (optional)">
          <TextInput value={contextLength} inputMode="numeric" placeholder="200000" onChange={(e) => setContextLength(e.target.value)} />
        </Field>
        <Field label="Extra headers" hint="one KEY: VALUE per line">
          <Textarea value={headers} mono rows={3} placeholder={"CF-Access-Client-Id: …\nCF-Access-Client-Secret: …"} onChange={(e) => setHeaders(e.target.value)} />
        </Field>
        {error !== null && <p className="error">{error}</p>}
      </form>
    </Modal>
  );
}
