import { useState, type FormEvent } from "react";
import type { BaiClient } from "@bai/api/client";
import type { ProviderInfo, ProviderListResponse } from "@bai/shared";

/**
 * Settings: provider/account management + default model. Same endpoints the
 * TUI's ctrl+p wizard uses — add an account here and the TUI's picker picks
 * it up live via provider.updated.
 */
export function Settings({
  client,
  list,
  refresh,
}: {
  client: BaiClient;
  list: ProviderListResponse | null;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutate = async (fn: () => Promise<void>, okMessage: string): Promise<void> => {
    try {
      await fn();
      await refresh();
      setError(null);
      setNotice(okMessage);
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="settings">
      <h2>Providers</h2>
      {error !== null && <div className="error">{error}</div>}
      {notice !== null && <div className="notice">{notice}</div>}
      {list === null && <p className="dim">Loading…</p>}
      {list !== null && (
        <>
          {list.providers.map((p) => (
            <ProviderCard key={p.id} provider={p} client={client} mutate={mutate} />
          ))}
          <AddAccount client={client} list={list} mutate={mutate} />
          <DefaultModel client={client} list={list} mutate={mutate} />
        </>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  client,
  mutate,
}: {
  provider: ProviderInfo;
  client: BaiClient;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  return (
    <div className={`provider-card ${provider.connected ? "connected" : ""}`}>
      <div className="provider-head">
        <strong>{provider.name}</strong>
        <span className="dim">
          {provider.id} · {provider.adapter}
          {provider.baseUrl !== undefined ? ` · ${provider.baseUrl}` : ""}
        </span>
        {provider.connected && <span className="check">✓</span>}
      </div>
      {provider.accounts.length > 0 && (
        <ul className="accounts">
          {provider.accounts.map((a) => (
            <li key={a.id}>
              <span>
                {a.label} <span className="dim">({a.id})</span>
                {a.baseUrl !== undefined && <span className="dim"> · {a.baseUrl}</span>}
              </span>
              <span className="dim">{a.source === "env" ? "from environment" : "api key"}</span>
              {a.source === "api" && (
                <button
                  className="danger"
                  onClick={() => {
                    void mutate(() => client.deleteAccount(provider.id, a.id), `Removed ${a.label}`);
                  }}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddAccount({
  client,
  list,
  mutate,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [provider, setProvider] = useState("");
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const selected = list.providers.find((p) => p.id === provider);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (provider.length === 0 || accountId.length === 0 || key.length === 0) return;
    void mutate(
      () =>
        client.putAccount(provider, accountId, {
          label: label.length > 0 ? label : accountId,
          key,
          ...(baseUrl.length > 0 ? { baseUrl } : {}),
        }),
      `Added account "${label.length > 0 ? label : accountId}" for ${provider}`,
    );
    setAccountId("");
    setLabel("");
    setKey("");
    setBaseUrl("");
  };

  return (
    <form
      className="add-account"
      onSubmit={(e) => {
        submit(e);
      }}
    >
      <h3>Add account</h3>
      <p className="dim">Multiple accounts per provider are fine — each keeps its own key. Keys are stored server-side (auth.json, 0600) and never echoed back.</p>
      <div className="form-grid">
        <label>
          provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">choose…</option>
            {list.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          account id
          <input value={accountId} placeholder="personal, work…" onChange={(e) => setAccountId(e.target.value)} />
        </label>
        <label>
          label
          <input value={label} placeholder="display name" onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          api key
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        {selected !== undefined && selected.baseUrl === undefined && selected.source !== "catalog" && (
          <label>
            base url
            <input value={baseUrl} placeholder="https://…/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
        )}
      </div>
      <button type="submit" disabled={provider.length === 0 || accountId.length === 0 || key.length === 0}>
        add account
      </button>
    </form>
  );
}

function DefaultModel({
  client,
  list,
  mutate,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const connected = list.providers.filter((p) => p.connected && p.models.length > 0);
  const [model, setModel] = useState(list.default.model ?? "");
  const [custom, setCustom] = useState("");

  const save = (value: string): void => {
    if (value.length === 0) return;
    void mutate(
      async () => {
        await client.putConfig({ models: { default: value } });
      },
      `Default model set to ${value}`,
    );
  };

  return (
    <form
      className="default-model"
      onSubmit={(e) => {
        e.preventDefault();
        save(custom.length > 0 ? custom : model);
      }}
    >
      <h3>Default model</h3>
      <p className="dim">Used by new sessions; per-session picks (chat header) override it. Current: {list.default.model ?? "stub/echo"}</p>
      <div className="form-grid">
        <label>
          from catalog
          <select value={model} onChange={(e) => { setModel(e.target.value); setCustom(""); }}>
            <option value="">choose…</option>
            {connected.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          or any model id
          <input value={custom} placeholder="provider/model" onChange={(e) => { setCustom(e.target.value); setModel(""); }} />
        </label>
      </div>
      <button type="submit" disabled={model.length === 0 && custom.length === 0}>save default</button>
    </form>
  );
}
