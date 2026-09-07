import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type {
  AgentInfo,
  MediaGenConfig,
  ProviderInfo,
  ProviderListResponse,
  ThemeId,
} from "@bai/shared";
import { isZdrCapableModel, sortModelsZdrFirst, THEME_OPTIONS } from "@bai/shared";
import { sortProviders } from "./provider-utils";

/**
 * Settings, divided into sections (the nested sidebar's entries): User,
 * General, and Model Providers. Each section renders one scrollable
 * heading-content page in the main pane:
 *
 * - User — display name (injected into every agent's <env> block).
 * - General — default agent + default model (what new sessions resolve).
 * - Model Providers — the prefer-ZDR preference, ALL catalog providers as
 *   expandable cards (accounts, remove, add-account), and the Image/Video
 *   Gen defaults (provider · account · model).
 *
 * Same endpoints the TUI's ctrl+p wizard uses — add an account here and the
 * TUI's picker picks it up live via provider.updated; every setting writes
 * the global config layer via PUT /api/config and propagates to all surfaces
 * via config.updated.
 */

/** The settings sections (the nested sidebar's entries). */
export type SettingsSection = "user" | "general" | "providers";

/** Nested-sidebar list: the settings sections. */
export function SettingsNav({
  selected,
  onSelect,
}: {
  selected: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}) {
  const entries: { id: SettingsSection; title: string; dim: string }[] = [
    { id: "user", title: "User", dim: "who bai works for" },
    { id: "general", title: "General", dim: "default agent · model" },
    { id: "providers", title: "Model Providers", dim: "accounts · media gen" },
  ];
  return (
    <div className="settings-nav">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={selected === entry.id ? "provider-item active" : "provider-item"}
          onClick={() => onSelect(entry.id)}
        >
          <span className="title">{entry.title}</span>
          <span className="dim">{entry.dim}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Main pane for the settings section: one section's scrollable
 * heading-content page. Owns the mutation error/notice state.
 */
export function SettingsPane({
  client,
  list,
  refresh,
  fetching,
  section,
  agents,
  userName,
  preferZdr,
  defaultAgent,
  imageGen,
  videoGen,
  theme,
  onOpenThemePicker,
}: {
  client: BaiClient;
  /** Null until the first engagement fetch lands (User works without it). */
  list: ProviderListResponse | null;
  refresh: () => Promise<void>;
  /** True while a provider-list refetch is in flight (list already shown). */
  fetching: boolean;
  section: SettingsSection;
  /** Live agent catalog (App-owned) — the default-agent select. */
  agents: AgentInfo[];
  /** Config snapshot for the forms (firehose-refreshed by the caller). */
  userName?: string;
  preferZdr?: boolean;
  defaultAgent?: string;
  imageGen?: MediaGenConfig;
  videoGen?: MediaGenConfig;
  /** Active theme (App-resolved) — the General pane's theme card. */
  theme: ThemeId;
  /** Open the theme picker modal (App-owned). */
  onOpenThemePicker: () => void;
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

  if (section === "user") {
    return (
      <div className="settings">
        {error !== null && <div className="error">{error}</div>}
        {notice !== null && <div className="notice">{notice}</div>}
        <UserPane client={client} userName={userName} mutate={mutate} />
      </div>
    );
  }

  if (list === null) {
    return (
      <div className="settings">
        <p className="dim">Loading…</p>
      </div>
    );
  }

  return (
    <div className="settings">
      {error !== null && <div className="error">{error}</div>}
      {notice !== null && <div className="notice">{notice}</div>}
      {section === "general" ? (
        <GeneralPane
          client={client}
          list={list}
          agents={agents}
          defaultAgent={defaultAgent}
          preferZdr={preferZdr}
          theme={theme}
          onOpenThemePicker={onOpenThemePicker}
          mutate={mutate}
        />
      ) : (
        <ProvidersPane
          client={client}
          list={list}
          fetching={fetching}
          mutate={mutate}
          preferZdr={preferZdr}
          imageGen={imageGen}
          videoGen={videoGen}
        />
      )}
    </div>
  );
}

/** User section: the display name (agents see it via the <env> block). */
function UserPane({
  client,
  userName,
  mutate,
}: {
  client: BaiClient;
  userName?: string;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [name, setName] = useState(userName ?? "");

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    void mutate(
      async () => {
        await client.putConfig({ user: { name: trimmed } });
      },
      `User name set to ${trimmed}`,
    );
  };

  return (
    <>
      <h2>User</h2>
      <form
        className="settings-card"
        onSubmit={(e) => {
          submit(e);
        }}
      >
        <h3>User name</h3>
        <p className="dim">Injected into every agent's env block — agents address you by it.</p>
        <div className="form-grid">
          <label>
            display name
            <input
              value={name}
              placeholder="your name…"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <button type="submit" disabled={name.trim().length === 0}>
          save name
        </button>
      </form>
    </>
  );
}

/** General section: the defaults new sessions resolve (agent, then model) + the UI theme. */
function GeneralPane({
  client,
  list,
  agents,
  defaultAgent,
  preferZdr,
  theme,
  onOpenThemePicker,
  mutate,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  agents: AgentInfo[];
  defaultAgent?: string;
  preferZdr?: boolean;
  theme: ThemeId;
  onOpenThemePicker: () => void;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  return (
    <>
      <h2>General</h2>
      <ThemeCard theme={theme} onOpenThemePicker={onOpenThemePicker} />
      <DefaultAgentForm client={client} agents={agents} current={defaultAgent} mutate={mutate} />
      <DefaultModel client={client} list={list} preferZdr={preferZdr} mutate={mutate} />
    </>
  );
}

/** UI theme (config theme): shows the active theme, opens the picker modal. */
function ThemeCard({ theme, onOpenThemePicker }: { theme: ThemeId; onOpenThemePicker: () => void }) {
  const label = THEME_OPTIONS.find((opt) => opt.value === theme)?.label ?? theme;
  return (
    <div className="settings-card theme-card">
      <h3>Theme</h3>
      <p className="dim">
        One theme everywhere — the terminal picks it up live (config-updated), and this
        browser remembers it for the next boot. Current: {label}
      </p>
      <button type="button" onClick={onOpenThemePicker}>
        change theme
      </button>
    </div>
  );
}

/** Default agent for sessions that select none (config agents.default). */
function DefaultAgentForm({
  client,
  agents,
  current,
  mutate,
}: {
  client: BaiClient;
  agents: AgentInfo[];
  current?: string;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [agent, setAgent] = useState(current ?? "build");

  // build first, then file agents alphabetically (same order as the TUI
  // switcher and the Agents section nav).
  const sorted = [...agents].sort((a, b) => {
    if (a.name === "build") return -1;
    if (b.name === "build") return 1;
    return a.name.localeCompare(b.name);
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void mutate(
      async () => {
        await client.putConfig({ agents: { default: agent } });
      },
      `Default agent set to ${agent}`,
    );
  };

  return (
    <form
      className="settings-card"
      onSubmit={(e) => {
        submit(e);
      }}
    >
      <h3>Default agent</h3>
      <p className="dim">
        Used by sessions that select none. Current: {current ?? "build (built-in default)"}
      </p>
      <div className="form-grid">
        <label>
          agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {sorted.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.name === "build" ? " — built-in default" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit">save default agent</button>
    </form>
  );
}

/** Model Providers section: ZDR preference, all providers, media-gen defaults. */
function ProvidersPane({
  client,
  list,
  fetching,
  mutate,
  preferZdr,
  imageGen,
  videoGen,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  fetching: boolean;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  preferZdr?: boolean;
  imageGen?: MediaGenConfig;
  videoGen?: MediaGenConfig;
}) {
  // Single-expanded accordion: one provider's accounts + add form at a time
  // keeps the 200+ catalog page light (forms mount lazily on expand).
  const [expanded, setExpanded] = useState<string | null>(null);
  const sorted = sortProviders(list.providers);

  return (
    <>
      <h2>Model Providers</h2>
      <ZdrToggle client={client} preferZdr={preferZdr} mutate={mutate} />
      <h3 className="settings-subheading">LLMs</h3>
      <p className="dim">
        Every provider the catalog knows — connect one by adding an account. Connected first.
        {fetching ? " updating…" : ""}
      </p>
      <div className="provider-accordion">
        {sorted.map((p) => (
          <div key={p.id} className="provider-accordion-item">
            <button
              type="button"
              className={expanded === p.id ? "provider-item active" : "provider-item"}
              onClick={() => setExpanded(expanded === p.id ? null : p.id)}
            >
              <span className="title">{p.name}</span>
              <span className="dim">{p.adapter}</span>
              {p.connected && (
                <span className="check" title="connected">
                  <Check size={12} aria-hidden="true" />
                </span>
              )}
            </button>
            {expanded === p.id && <ProviderDetail provider={p} client={client} mutate={mutate} />}
          </div>
        ))}
      </div>
      <MediaGenForm
        kind="imageGen"
        title="Image Gen"
        client={client}
        list={list}
        config={imageGen}
        mutate={mutate}
      />
      <MediaGenForm
        kind="videoGen"
        title="Video Gen"
        client={client}
        list={list}
        config={videoGen}
        mutate={mutate}
      />
    </>
  );
}

/** Prefer ZDR-capable models (config models.preferZdr) — applies immediately. */
function ZdrToggle({
  client,
  preferZdr,
  mutate,
}: {
  client: BaiClient;
  preferZdr?: boolean;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={preferZdr === true}
        onChange={(e) => {
          const on = e.target.checked;
          void mutate(
            async () => {
              await client.putConfig({ models: { preferZdr: on } });
            },
            on ? "Prefer ZDR-capable models: on" : "Prefer ZDR-capable models: off",
          );
        }}
      />
      <span className="title">Prefer ZDR models</span>
      <span className="dim">
        Sorts zero-data-retention-capable models first in the pickers. Capability is bai's
        curated list; actual ZDR requires an org-level agreement with the provider.
      </span>
    </label>
  );
}

/** One provider's expanded card: meta line + accounts + remove + add form. */
function ProviderDetail({
  provider,
  client,
  mutate,
}: {
  provider: ProviderInfo;
  client: BaiClient;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  return (
    <div className="provider-detail">
      <p className="dim">
        {provider.id} · {provider.adapter}
        {provider.baseUrl !== undefined ? ` · ${provider.baseUrl}` : ""}
      </p>
      <div className={`provider-card ${provider.connected ? "connected" : ""}`}>
        <div className="provider-head">
          <strong>accounts</strong>
          {provider.connected && (
            <span className="check">
              <Check size={12} aria-hidden="true" /> connected
            </span>
          )}
        </div>
        {provider.accounts.length === 0 && (
          <p className="dim">No accounts yet — add one below.</p>
        )}
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
      <AddAccount provider={provider} client={client} mutate={mutate} />
    </div>
  );
}

/** Add-account form scoped to one provider — no provider dropdown needed. */
function AddAccount({
  provider,
  client,
  mutate,
}: {
  provider: ProviderInfo;
  client: BaiClient;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (accountId.length === 0 || key.length === 0) return;
    void mutate(
      () =>
        client.putAccount(provider.id, accountId, {
          label: label.length > 0 ? label : accountId,
          key,
          ...(baseUrl.length > 0 ? { baseUrl } : {}),
        }),
      `Added account "${label.length > 0 ? label : accountId}" for ${provider.id}`,
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
      <h3>Add account · {provider.name}</h3>
      <p className="dim">Multiple accounts per provider are fine — each keeps its own key. Keys are stored server-side (auth.json, 0600) and never echoed back.</p>
      <div className="form-grid">
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
        {/* Catalog providers have known endpoints; config/account-only
            providers without a baseUrl must be told where to send requests. */}
        {provider.baseUrl === undefined && provider.source !== "catalog" && (
          <label>
            base url
            <input value={baseUrl} placeholder="https://…/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
        )}
      </div>
      <button type="submit" disabled={accountId.length === 0 || key.length === 0}>
        add account
      </button>
    </form>
  );
}

/**
 * One media-generation modality's defaults (config imageGen / videoGen):
 * provider (any provider id — media vendors may not be in the LLM catalog,
 * hence the free-text input with a datalist), account (that provider's saved
 * accounts, when known), and model. The workbench executor falls back to
 * this model when a job doesn't name one.
 */
function MediaGenForm({
  kind,
  title,
  client,
  list,
  config,
  mutate,
}: {
  kind: "imageGen" | "videoGen";
  title: string;
  client: BaiClient;
  list: ProviderListResponse;
  config?: MediaGenConfig;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [provider, setProvider] = useState(config?.provider ?? "");
  const [account, setAccount] = useState(config?.account ?? "");
  const [model, setModel] = useState(config?.model ?? "");

  const providerIds = list.providers.map((p) => p.id).sort((a, b) => a.localeCompare(b));
  const knownProvider = list.providers.find((p) => p.id === provider.trim());
  const accountIds = knownProvider?.accounts.map((a) => a.id) ?? [];

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const providerId = provider.trim();
    const modelId = model.trim();
    if (providerId.length === 0 || modelId.length === 0) return;
    const value: MediaGenConfig = {
      provider: providerId,
      model: modelId,
      ...(account.trim().length > 0 ? { account: account.trim() } : {}),
    };
    // Branch for the typed ConfigPatch (a computed key widens the type).
    void mutate(
      async () => {
        if (kind === "imageGen") await client.putConfig({ imageGen: value });
        else await client.putConfig({ videoGen: value });
      },
      `${title} default set to ${modelId} via ${providerId}`,
    );
  };

  return (
    <form
      className="settings-card media-gen"
      onSubmit={(e) => {
        submit(e);
      }}
    >
      <h3>{title}</h3>
      <p className="dim">
        Defaults for the {kind === "imageGen" ? "image" : "video"} workbench — jobs without an
        explicit model use this. Accounts come from the provider's saved keys (LLMs above).
        Empty fields keep their saved value.
      </p>
      <div className="form-grid">
        <label>
          provider
          <input
            list={`${kind}-providers`}
            value={provider}
            placeholder="openai, fal…"
            onChange={(e) => setProvider(e.target.value)}
          />
          <datalist id={`${kind}-providers`}>
            {providerIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <label>
          account
          <input
            list={`${kind}-accounts`}
            value={account}
            placeholder="provider default"
            onChange={(e) => setAccount(e.target.value)}
          />
          <datalist id={`${kind}-accounts`}>
            {accountIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        <label>
          model
          <input value={model} placeholder={kind === "imageGen" ? "gpt-image-2…" : "veo-3…"} onChange={(e) => setModel(e.target.value)} />
        </label>
      </div>
      <button type="submit" disabled={provider.trim().length === 0 || model.trim().length === 0}>
        save {title.toLowerCase()} default
      </button>
    </form>
  );
}

function DefaultModel({
  client,
  list,
  preferZdr,
  mutate,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  preferZdr?: boolean;
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
                {sortModelsZdrFirst(
                  [...p.models].sort((a, b) => a.label.localeCompare(b.label)),
                  preferZdr === true,
                ).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {preferZdr === true && isZdrCapableModel(m.id, m.provider) ? " · zdr" : ""}
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
