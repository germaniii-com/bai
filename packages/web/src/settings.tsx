import { useState, type FormEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type {
  AgentInfo,
  MediaGenConfig,
  ProviderInfo,
  ProviderListResponse,
} from "@bai/shared";
import { isZdrCapableModel, sortModelsZdrFirst, THEME_OPTIONS } from "@bai/shared";
import { sortProviders } from "./provider-utils";
import { AgentModal } from "./agent-picker";
import { ModelModal } from "./model-picker";
import { ModelCapabilityBadges } from "./model-capabilities";
import { Button, Card, Combobox, Field, PageHeader, SectionHeader, SubNav, SubNavItem, TextInput, ToggleRow } from "./components";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Settings, divided into sections (the nested sidebar's entries): User,
 * General, and Model Providers. Each section renders one scrollable
 * heading-content page in the main pane:
 *
 * - User — display name (injected into every agent's <env> block).
 * - General — theme, default agent + default model (what new sessions
 *   resolve) — both picked through the SAME modals the chat header uses
 *   (AgentModal / ModelModal), so one picker everywhere.
 * - Model Providers — the prefer-ZDR preference, ALL catalog providers as
 *   expandable cards (accounts, remove, add-account), and the Image/Video
 *   Gen defaults (provider · account · model).
 *
 * Same endpoints the TUI's ctrl+p wizard uses — add an account here and the
 * TUI's picker picks it up live via provider.updated; every setting writes
 * the global config layer via PUT /api/config and propagates to all surfaces
 * via config.updated. Feedback rides the shared toast (no inline banners).
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
    <SubNav>
      {entries.map((entry) => (
        <SubNavItem
          key={entry.id}
          title={entry.title}
          subtitle={entry.dim}
          selected={selected === entry.id}
          onClick={() => onSelect(entry.id)}
          ariaCurrent={selected === entry.id ? "page" : undefined}
        />
      ))}
    </SubNav>
  );
}

/**
 * Main pane for the settings section: one section's scrollable
 * heading-content page. Mutations report through the shared toast.
 */
export function SettingsPane({
  client,
  list,
  refresh,
  fetching,
  section,
  agents,
  refreshAgents,
  userName,
  preferZdr,
  defaultAgent,
  imageGen,
  videoGen,
  theme,
  onOpenThemePicker,
  onNotice,
}: {
  client: BaiClient;
  /** Null until the first engagement fetch lands (User works without it). */
  list: ProviderListResponse | null;
  refresh: () => Promise<void>;
  /** True while a provider-list refetch is in flight (list already shown). */
  fetching: boolean;
  section: SettingsSection;
  /** Live agent catalog (App-owned) — the default-agent picker. */
  agents: AgentInfo[];
  /** Agents refetch (the default-agent modal's engagement refresh). */
  refreshAgents: () => Promise<void>;
  /** Config snapshot for the forms (firehose-refreshed by the caller). */
  userName?: string;
  preferZdr?: boolean;
  defaultAgent?: string;
  imageGen?: MediaGenConfig;
  videoGen?: MediaGenConfig;
  /** Active theme id (built-in or custom file stem) — the General pane's theme card. */
  theme: string;
  /** Open the theme picker modal (App-owned). */
  onOpenThemePicker: () => void;
  /** Toast feedback (success/error). */
  onNotice: OnNotice;
}) {
  const mutate = async (fn: () => Promise<void>, okMessage: string): Promise<void> => {
    try {
      await fn();
      await refresh();
      onNotice(okMessage);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  if (section === "user") {
    return (
      <div className="settings">
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
      {section === "general" ? (
        <GeneralPane
          client={client}
          list={list}
          refresh={refresh}
          agents={agents}
          refreshAgents={refreshAgents}
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
      <PageHeader title="User" />
      <Card as="form" onSubmit={submit}>
        <SectionHeader
          title="User name"
          lede="Injected into every agent's env block — agents address you by it."
        />
        <div className="form-grid">
          <Field label="Display name">
            <TextInput
              value={name}
              placeholder="your name…"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={name.trim().length === 0}>
          Save name
        </Button>
      </Card>
    </>
  );
}

/** General section: the defaults new sessions resolve (agent, then model) + the UI theme. */
function GeneralPane({
  client,
  list,
  refresh,
  agents,
  refreshAgents,
  defaultAgent,
  preferZdr,
  theme,
  onOpenThemePicker,
  mutate,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  refresh: () => Promise<void>;
  agents: AgentInfo[];
  refreshAgents: () => Promise<void>;
  defaultAgent?: string;
  preferZdr?: boolean;
  theme: string;
  onOpenThemePicker: () => void;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  return (
    <>
      <PageHeader title="General" />
      <ThemeCard theme={theme} onOpenThemePicker={onOpenThemePicker} />
      <DefaultAgentCard client={client} agents={agents} refreshAgents={refreshAgents} current={defaultAgent} mutate={mutate} />
      <DefaultModelCard client={client} list={list} preferZdr={preferZdr} refresh={refresh} mutate={mutate} />
    </>
  );
}

/** UI theme (config theme): shows the active theme, opens the picker modal. */
function ThemeCard({ theme, onOpenThemePicker }: { theme: string; onOpenThemePicker: () => void }) {
  const label = THEME_OPTIONS.find((opt) => opt.value === theme)?.label ?? theme;
  return (
    <Card className="theme-card">
      <SectionHeader
        title="Theme"
        lede={
          <>
            One theme everywhere — the terminal picks it up live (config-updated), and this
            browser remembers it for the next boot. Current: {label}
          </>
        }
      />
      <div>
        <Button variant="outline" onClick={onOpenThemePicker}>
          Change theme
        </Button>
      </div>
    </Card>
  );
}

/**
 * Default agent for sessions that select none (config agents.default): a
 * trigger button opening the SAME AgentModal the chat header uses (capture
 * mode) — the pick writes the config immediately, no separate save step.
 */
function DefaultAgentCard({
  client,
  agents,
  refreshAgents,
  current,
  mutate,
}: {
  client: BaiClient;
  agents: AgentInfo[];
  refreshAgents: () => Promise<void>;
  current?: string;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const effective = current ?? "build";

  return (
    <Card>
      <SectionHeader
        title="Default agent"
        lede={<>Used by sessions that select none. Current: {current ?? "build (built-in default)"}</>}
      />
      <div>
        <button
          type="button"
          className="model-button"
          onClick={() => setPickerOpen(true)}
          aria-haspopup="dialog"
          aria-label={`default agent: ${effective}`}
        >
          <span className="dim">agent</span>
          <span className="model-current">{effective}</span>
          <span className="model-caret" aria-hidden="true">
            <ChevronDown size={12} />
          </span>
        </button>
      </div>
      {pickerOpen && (
        <AgentModal
          client={client}
          agents={agents}
          active={null}
          configDefaultAgent={current}
          refreshAgents={refreshAgents}
          current={effective}
          onClose={() => setPickerOpen(false)}
          onPick={(name) => {
            setPickerOpen(false);
            void mutate(
              async () => {
                await client.putConfig({ agents: { default: name } });
              },
              `Default agent set to ${name}`,
            );
          }}
        />
      )}
    </Card>
  );
}

/**
 * Default model (config models.default): a trigger button opening the SAME
 * ModelModal the chat header uses — with no session open it already writes
 * the global default (model + optional account pin), so no capture mode is
 * needed. A free-text field covers catalog-external model ids.
 */
function DefaultModelCard({
  client,
  list,
  preferZdr,
  refresh,
  mutate,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  preferZdr?: boolean;
  refresh: () => Promise<void>;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const current = list.default.model ?? "stub/echo";
  const currentModel = list.providers.flatMap((p) => p.models).find((m) => m.id === current);

  const saveCustom = (e: FormEvent): void => {
    e.preventDefault();
    const value = custom.trim();
    if (value.length === 0) return;
    void mutate(
      async () => {
        await client.putConfig({ models: { default: value } });
      },
      `Default model set to ${value}`,
    );
    setCustom("");
  };

  return (
    <Card as="form" onSubmit={saveCustom}>
      <SectionHeader
        title="Default model"
        lede={<>Used by new sessions; per-session picks (chat header) override it. Current: {list.default.model ?? "stub/echo"}</>}
      />
      <div>
        <button
          type="button"
          className="model-button"
          onClick={() => setPickerOpen(true)}
          aria-haspopup="dialog"
          aria-label={`default model: ${current}`}
        >
          <span className="dim">model</span>
          <span className="model-current">{current}</span>
          {currentModel !== undefined && <ModelCapabilityBadges model={currentModel} />}
          <span className="model-caret" aria-hidden="true">
            <ChevronDown size={12} />
          </span>
        </button>
      </div>
      <div className="form-grid">
        <Field label="Or any model id" hint="(provider/model — for ids outside the catalog)">
          <TextInput
            value={custom}
            placeholder="provider/model"
            onChange={(e) => setCustom(e.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={custom.trim().length === 0}>
          Save default
        </Button>
      </div>
      {pickerOpen && (
        <ModelModal
          client={client}
          list={list}
          active={null}
          preferZdr={preferZdr}
          refreshProviders={refresh}
          current={current}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Card>
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
      <PageHeader title="Model Providers" />
      <ZdrToggle client={client} preferZdr={preferZdr} mutate={mutate} />
      <h3 className="settings-subheading">LLMs</h3>
      <p className="section-lede">
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
              aria-expanded={expanded === p.id}
              aria-controls={`provider-detail-${p.id}`}
            >
              <span className="title">{p.name}</span>
              <span className="dim">{p.adapter}</span>
              {p.connected && (
                <span className="check" title="connected">
                  <Check size={12} aria-hidden="true" />
                </span>
              )}
            </button>
            {expanded === p.id && <div id={`provider-detail-${p.id}`}><ProviderDetail provider={p} client={client} mutate={mutate} /></div>}
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
    <ToggleRow
      checked={preferZdr === true}
      title="Prefer ZDR models"
      description={
        "Sorts zero-data-retention-capable models first in the pickers. Capability is bai's " +
        "curated list; actual ZDR requires an org-level agreement with the provider."
      }
      onChange={(on) => {
        void mutate(
          async () => {
            await client.putConfig({ models: { preferZdr: on } });
          },
          on ? "Prefer ZDR-capable models: on" : "Prefer ZDR-capable models: off",
        );
      }}
    />
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
      <p className="section-lede">
        {provider.id} · {provider.adapter}
        {provider.baseUrl !== undefined ? ` · ${provider.baseUrl}` : ""}
      </p>
      <Card className={provider.connected ? "connected" : undefined}>
        <div className="provider-head">
          <strong>Accounts</strong>
          {provider.connected && (
            <span className="check">
              <Check size={12} aria-hidden="true" /> connected
            </span>
          )}
        </div>
        {provider.accounts.length === 0 && (
          <p className="section-lede">No accounts yet — add one below.</p>
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
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      void mutate(() => client.deleteAccount(provider.id, a.id), `Removed ${a.label}`);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
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
    <Card as="form" onSubmit={submit}>
      <SectionHeader
        title={<>Add account · {provider.name}</>}
        lede="Multiple accounts per provider are fine — each keeps its own key. Keys are stored server-side (auth.json, 0600) and never echoed back."
      />
      <div className="form-grid">
        <Field label="Account id">
          <TextInput value={accountId} placeholder="personal, work…" onChange={(e) => setAccountId(e.target.value)} />
        </Field>
        <Field label="Label">
          <TextInput value={label} placeholder="display name" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="API key">
          <TextInput type="password" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        {/* Catalog providers have known endpoints; config/account-only
            providers without a baseUrl must be told where to send requests. */}
        {provider.baseUrl === undefined && provider.source !== "catalog" && (
          <Field label="Base URL">
            <TextInput value={baseUrl} placeholder="https://…/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
        )}
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={accountId.length === 0 || key.length === 0}>
          Add account
        </Button>
      </div>
    </Card>
  );
}

/**
 * One media-generation modality's defaults (config imageGen / videoGen):
 * provider (any provider id — media vendors may not be in the LLM catalog,
 * hence the creatable combobox), account (that provider's saved accounts,
 * creatable — the provider may be typed freely), and model. The workbench
 * executor falls back to this model when a job doesn't name one.
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
    <Card as="form" onSubmit={submit}>
      <SectionHeader
        title={title}
        lede={
          <>
            Defaults for the {kind === "imageGen" ? "image" : "video"} workbench — jobs without an
            explicit model use this. Accounts come from the provider's saved keys (LLMs above).
            Empty fields keep their saved value.
          </>
        }
      />
      <div className="form-grid">
        <Field label="Provider">
          <Combobox
            creatable
            value={provider}
            onChange={setProvider}
            options={providerIds.map((id) => ({ value: id, label: id }))}
            placeholder="openai, fal…"
            ariaLabel={`${title} provider`}
            emptyText="Type a provider id."
          />
        </Field>
        <Field label="Account" hint="(optional)">
          <Combobox
            creatable
            value={account}
            onChange={setAccount}
            options={accountIds.map((id) => ({ value: id, label: id }))}
            placeholder="provider default"
            ariaLabel={`${title} account`}
            emptyText="Type an account id."
          />
        </Field>
        <Field label="Model">
          <TextInput value={model} placeholder={kind === "imageGen" ? "gpt-image-2…" : "veo-3…"} onChange={(e) => setModel(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={provider.trim().length === 0 || model.trim().length === 0}>
          Save {title.toLowerCase()} default
        </Button>
      </div>
    </Card>
  );
}
