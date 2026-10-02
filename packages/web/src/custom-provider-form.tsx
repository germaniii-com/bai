import { useState, type FormEvent } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { CustomProviderBody, ProviderInfo, RemoteModelInfo } from "@bai/shared";
import { Button, Checkbox, Field, IconButton, Modal, TextInput } from "./components";
import { headersFromRows, mergeModelSelection, modelSelectionRows, slugifyProviderId, stripProviderPrefix, toggleModelSelection, type HeaderRow } from "./provider-utils";

/**
 * Create/edit a config-defined custom provider. Custom providers are
 * OpenAI-compatible only, so there is no adapter selector; the model list
 * comes from the endpoint's own `GET /models` (the fetch icon button)
 * instead of a free-text field. Writes the global config layer; the server's
 * config watcher invalidates the registry so the provider is usable on the
 * next message (no restart).
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
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>(
    provider !== undefined ? provider.models.map((m) => stripProviderPrefix(provider.id, m.id)) : [],
  );
  const [contextLength, setContextLength] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [available, setAvailable] = useState<RemoteModelInfo[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setHeaderRow = (index: number, patch: Partial<HeaderRow>): void => {
    setHeaderRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const fetchModels = (): void => {
    const url = baseUrl.trim();
    if (url.length === 0) {
      setModelsError("Base URL is required");
      return;
    }
    const parsedHeaders = headersFromRows(headerRows);
    void (async () => {
      setFetching(true);
      setModelsError(null);
      try {
        const fetched = await client.listProviderModels({
          baseUrl: url,
          ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
          ...(parsedHeaders !== undefined ? { headers: parsedHeaders } : {}),
          // Edit flows: the stored key was never returned to the browser, so
          // let the server fall back to it when no key is typed.
          ...(editing && provider !== undefined ? { provider: provider.id } : {}),
        });
        setAvailable(fetched);
        // Every fetched model arrives pre-selected; earlier selections stay.
        setModels((prev) => mergeModelSelection(prev, fetched));
      } catch (err) {
        setModelsError(err instanceof Error ? err.message : String(err));
      } finally {
        setFetching(false);
      }
    })();
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    // The id is the slug of the display name ("My Gateway" → "my-gateway");
    // edits keep the existing id (ids are immutable).
    const providerId = editing && provider !== undefined ? provider.id : slugifyProviderId(name);
    if (providerId.length === 0) {
      setError("Display name is required");
      return;
    }
    if (baseUrl.trim().length === 0) {
      setError("Base URL is required");
      return;
    }
    const ctx = contextLength.trim().length > 0 ? Number(contextLength) : undefined;
    if (ctx !== undefined && (!Number.isFinite(ctx) || ctx <= 0)) {
      setError("Context length must be a positive number");
      return;
    }
    const parsedHeaders = headersFromRows(headerRows);
    const body: CustomProviderBody = {
      ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      baseUrl: baseUrl.trim(),
      adapter: "openai-compatible",
      ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      ...(models.length > 0 ? { models } : {}),
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

  const rows = available === null ? [] : modelSelectionRows(available, models);
  const selectedFetched = available === null ? 0 : available.filter((m) => models.includes(m.id)).length;

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
      <form className="stack-form" onSubmit={submit}>
        <div className="form-grid form-grid-2">
          <Field label="Display Name">
            <TextInput value={name} placeholder="My Gateway" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Context Length (optional)">
            <TextInput value={contextLength} inputMode="numeric" placeholder="200000" onChange={(e) => setContextLength(e.target.value)} />
          </Field>
          <div className="field span-2">
            <span className="field-label" id="custom-provider-base-url-label">
              Base URL
            </span>
            <div className="base-url-row">
              <TextInput
                value={baseUrl}
                placeholder="https://gateway.example.com/v1"
                aria-labelledby="custom-provider-base-url-label"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <IconButton label="Fetch models" hint="Fetch models" disabled={fetching} onClick={fetchModels}>
                <RefreshCw size={14} aria-hidden="true" />
              </IconButton>
            </div>
          </div>
          <div className="field span-2">
            <span className="field-label">API Key</span>
            <TextInput type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
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
          <div className="field span-2">
            <span className="field-label">Model List</span>
          <div className="model-fetch-head">
            {available !== null && (
              <span className="dim">
                {selectedFetched} of {available.length} selected
              </span>
            )}
            {rows.length > 0 && (
              <span className="model-fetch-actions">
                <Button variant="ghost" size="sm" onClick={() => setModels(available?.map((m) => m.id) ?? [])}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setModels([])}>
                  Clear
                </Button>
              </span>
            )}
          </div>
          {rows.length > 0 && (
            <div className="checkbox-group model-fetch-list">
              {rows.map((m) => (
                <Checkbox
                  key={m.id}
                  label={m.name !== undefined ? `${m.id} · ${m.name}` : m.id}
                  checked={models.includes(m.id)}
                  onChange={(e) => setModels((prev) => toggleModelSelection(prev, m.id, e.target.checked))}
                />
              ))}
            </div>
          )}
          {available !== null && rows.length === 0 && <p className="dim">No models returned.</p>}
          {modelsError !== null && (
            <p className="error" role="alert">
              {modelsError}
            </p>
          )}
          </div>
        </div>
        {error !== null && <p className="error">{error}</p>}
      </form>
    </Modal>
  );
}
