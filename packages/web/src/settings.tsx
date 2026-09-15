import { useEffect, useState, type FormEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type {
  AgentInfo,
  MCPServerConfig,
  McpCatalogEntry,
  McpServerInfo,
  McpServerSource,
  MediaGenConfig,
  OAuthProviderInfo,
  ProviderInfo,
  ProviderListResponse,
  WebSearchProviderId,
  WebSearchStatus,
} from "@bai/shared";
import { isZdrCapableModel, sortModelsZdrFirst, THEME_OPTIONS } from "@bai/shared";
import { partitionProviders, sortProviders } from "./provider-utils";
import { AgentModal } from "./agent-picker";
import { ModelModal } from "./model-picker";
import { ModelCapabilityBadges } from "./model-capabilities";
import { OAuthModal } from "./oauth-modal";
import { CustomProviderModal } from "./custom-provider-form";
import { McpServerModal } from "./mcp-server-form";
import { Button, Card, Combobox, Field, PageHeader, SectionHeader, Select, SubNav, SubNavItem, TextInput, ToggleRow } from "./components";

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
export type SettingsSection = "user" | "general" | "providers" | "webSearch" | "integrations";

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
    { id: "webSearch", title: "Web Search", dim: "provider · fallback" },
    { id: "integrations", title: "Integrations", dim: "MCP servers" },
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

  if (section === "webSearch") {
    return (
      <div className="settings">
        <WebSearchPane client={client} onNotice={onNotice} />
      </div>
    );
  }

  if (section === "integrations") {
    return (
      <div className="settings">
        <IntegrationsPane client={client} onNotice={onNotice} />
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
          refresh={refresh}
          onNotice={onNotice}
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
  refresh,
  onNotice,
  preferZdr,
  imageGen,
  videoGen,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  fetching: boolean;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  refresh: () => Promise<void>;
  onNotice: (message: string, kind?: "success" | "error") => void;
  preferZdr?: boolean;
  imageGen?: MediaGenConfig;
  videoGen?: MediaGenConfig;
}) {
  // Single-expanded accordion: one provider's accounts + add form at a time
  // keeps the 200+ catalog page light (forms mount lazily on expand).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [oauth, setOauth] = useState<OAuthProviderInfo[]>([]);
  // OAuth target + intent: `connect` names/writes the default account, `add`
  // creates a new one, `reconnect` refreshes one specific account id.
  const [oauthTarget, setOauthTarget] = useState<
    { provider: ProviderInfo; intent: "connect" | "add" | "reconnect"; accountId?: string } | null
  >(null);
  const [customOpen, setCustomOpen] = useState(false);
  const sorted = sortProviders(list.providers);
  const oauthById = new Map(oauth.map((o) => [o.id, o]));
  const { custom, oauth: oauthProviders, catalog } = partitionProviders(sorted, oauthById.keys());

  const loadOauth = (): void => {
    void client.oauthProviders().then(setOauth).catch(() => undefined);
  };
  useEffect(loadOauth, [client]);

  const removeCustom = (p: ProviderInfo): void => {
    void mutate(() => client.deleteCustomProvider(p.id), `Removed ${p.name}`);
  };

  return (
    <>
      <PageHeader title="Model Providers" />
      <ZdrToggle client={client} preferZdr={preferZdr} mutate={mutate} />

      {/* --- Custom providers (config-defined endpoints) ------------------- */}
      <h3 className="settings-subheading">Custom Providers</h3>
      <p className="section-lede">
        Your own endpoints — any OpenAI-compatible, Anthropic, or Responses gateway.
      </p>
      <div className="provider-actions">
        <Button variant="outline" onClick={() => setCustomOpen(true)}>
          + Add a new custom provider
        </Button>
      </div>
      {custom.length === 0 ? (
        <p className="dim provider-empty">No custom providers yet.</p>
      ) : (
        <div className="provider-accordion">
          {custom.map((p) => (
            <AccordionProvider
              key={p.id}
              provider={p}
              variant="custom"
              expanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
              client={client}
              mutate={mutate}
              {...(oauthById.get(p.id) !== undefined ? { oauth: oauthById.get(p.id) as OAuthProviderInfo } : {})}
              onConnect={() => setOauthTarget({ provider: p, intent: "connect" })}
              onReconnectAccount={(accountId) => setOauthTarget({ provider: p, intent: "reconnect", accountId })}
              onAddAccount={() => setOauthTarget({ provider: p, intent: "add" })}
              onDeleteCustom={() => removeCustom(p)}
            />
          ))}
        </div>
      )}

      {/* --- OAuth providers (subscription / local logins) ----------------- */}
      <h3 className="settings-subheading">OAuth Providers</h3>
      <p className="section-lede">
        Sign in with a subscription or local credential — tokens are stored server-side.
        {fetching ? " updating…" : ""}
      </p>
      {oauthProviders.length === 0 ? (
        <p className="dim provider-empty">No OAuth providers available.</p>
      ) : (
        <div className="provider-accordion">
          {oauthProviders.map((p) => (
            <AccordionProvider
              key={p.id}
              provider={p}
              variant="oauth"
              expanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
              client={client}
              mutate={mutate}
              oauth={oauthById.get(p.id) as OAuthProviderInfo}
              onConnect={() => setOauthTarget({ provider: p, intent: "connect" })}
              onReconnectAccount={(accountId) => setOauthTarget({ provider: p, intent: "reconnect", accountId })}
              onAddAccount={() => setOauthTarget({ provider: p, intent: "add" })}
            />
          ))}
        </div>
      )}

      {/* --- Catalog list (models.dev ⊕ curated overlay), height-capped ---- */}
      <h3 className="settings-subheading">Catalog List</h3>
      <p className="section-lede">
        Every other provider the catalog knows — connect one by adding an account. Connected first.
      </p>
      <div className="provider-accordion catalog-scroll">
        {catalog.map((p) => (
          <AccordionProvider
            key={p.id}
            provider={p}
            variant="catalog"
            expanded={expanded === p.id}
            onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
            client={client}
            mutate={mutate}
            {...(oauthById.get(p.id) !== undefined ? { oauth: oauthById.get(p.id) as OAuthProviderInfo } : {})}
            onConnect={() => setOauthTarget({ provider: p, intent: "connect" })}
              onReconnectAccount={(accountId) => setOauthTarget({ provider: p, intent: "reconnect", accountId })}
          />
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
      {oauthTarget !== null && (
        <OAuthModal
          client={client}
          provider={oauthTarget.provider.id}
          providerName={oauthTarget.provider.name}
          defaultAccount={oauthById.get(oauthTarget.provider.id)?.defaultAccount}
          intent={oauthTarget.intent}
          {...(oauthTarget.accountId !== undefined ? { accountId: oauthTarget.accountId } : {})}
          existingAccounts={oauthTarget.provider.accounts
            .filter((a) => a.source === "oauth")
            .map((a) => a.id)}
          onClose={() => setOauthTarget(null)}
          onConnected={() => {
            void refresh();
            loadOauth();
          }}
          onNotice={onNotice}
        />
      )}
      {customOpen && (
        <CustomProviderModal
          client={client}
          onClose={() => setCustomOpen(false)}
          onSaved={() => {
            void refresh();
          }}
          onNotice={onNotice}
        />
      )}
    </>
  );
}

/** One accordion row: provider header + lazily-mounted detail. */
function AccordionProvider({
  provider,
  variant,
  expanded,
  onToggle,
  client,
  mutate,
  oauth,
  onConnect,
  onAddAccount,
  onReconnectAccount,
  onDeleteCustom,
}: {
  provider: ProviderInfo;
  variant: "custom" | "oauth" | "catalog";
  expanded: boolean;
  onToggle: () => void;
  client: BaiClient;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  oauth?: OAuthProviderInfo;
  onConnect?: () => void;
  onAddAccount?: () => void;
  onReconnectAccount?: (accountId: string) => void;
  onDeleteCustom?: () => void;
}) {
  const hint =
    variant === "oauth" && oauth !== undefined
      ? `${oauth.connected ? "connected" : "not connected"} · ${oauth.hint ?? oauth.method}`
      : provider.baseUrl !== undefined
        ? `${provider.adapter} · ${provider.baseUrl}`
        : provider.adapter;
  return (
    <div className="provider-accordion-item">
      <button
        type="button"
        className={expanded ? "provider-item active" : "provider-item"}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`provider-detail-${provider.id}`}
      >
        <span className="title">{provider.name}</span>
        <span className="dim">{hint}</span>
        {provider.connected && (
          <span className="check" title="connected">
            <Check size={12} aria-hidden="true" />
          </span>
        )}
      </button>
      {expanded && (
        <div id={`provider-detail-${provider.id}`}>
          <ProviderDetail
            provider={provider}
            variant={variant}
            client={client}
            mutate={mutate}
            {...(oauth !== undefined ? { oauth } : {})}
            {...(onConnect !== undefined ? { onConnect } : {})}
            {...(onAddAccount !== undefined ? { onAddAccount } : {})}
            {...(onReconnectAccount !== undefined ? { onReconnectAccount } : {})}
            {...(onDeleteCustom !== undefined ? { onDeleteCustom } : {})}
          />
        </div>
      )}
    </div>
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

/** One provider's expanded card, varied by section (custom / oauth / catalog). */
function ProviderDetail({
  provider,
  variant,
  client,
  mutate,
  oauth,
  onConnect,
  onAddAccount,
  onReconnectAccount,
  onDeleteCustom,
}: {
  provider: ProviderInfo;
  variant: "custom" | "oauth" | "catalog";
  client: BaiClient;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  oauth?: OAuthProviderInfo;
  onConnect?: () => void;
  onAddAccount?: () => void;
  onReconnectAccount?: (accountId: string) => void;
  onDeleteCustom?: () => void;
}) {
  return (
    <div className="provider-detail">
      {variant === "custom" && (
        <Card>
          <div className="provider-head">
            <strong>Definition</strong>
            {onDeleteCustom !== undefined && (
              <Button variant="danger" size="sm" onClick={onDeleteCustom}>
                Remove provider
              </Button>
            )}
          </div>
          <dl className="provider-meta">
            <div>
              <dt>id</dt>
              <dd className="mono">{provider.id}</dd>
            </div>
            <div>
              <dt>adapter</dt>
              <dd>{provider.adapter}</dd>
            </div>
            <div>
              <dt>endpoint</dt>
              <dd className="mono">{provider.baseUrl ?? "—"}</dd>
            </div>
            <div>
              <dt>models</dt>
              <dd>{provider.models.length}</dd>
            </div>
            {provider.headerCount !== undefined && (
              <div>
                <dt>extra headers</dt>
                <dd>{provider.headerCount}</dd>
              </div>
            )}
            {provider.contextLength !== undefined && (
              <div>
                <dt>context</dt>
                <dd>{provider.contextLength.toLocaleString()} tokens</dd>
              </div>
            )}
          </dl>
        </Card>
      )}

      {oauth !== undefined && (
        <div className="provider-oauth">
          {!oauth.connected && onConnect !== undefined && (
            <Button variant="primary" size="sm" onClick={onConnect}>
              Connect
            </Button>
          )}
          {oauth.connected && onAddAccount !== undefined && (
            <Button variant="primary" size="sm" onClick={onAddAccount}>
              + Add another account
            </Button>
          )}
          <span className="dim">{oauth.hint ?? oauth.method}</span>
        </div>
      )}

      <ProviderAccounts
        provider={provider}
        client={client}
        mutate={mutate}
        oauth={oauth !== undefined}
        {...(onReconnectAccount !== undefined ? { onReconnectAccount } : {})}
      />
      {/* OAuth providers authenticate via the browser flow above — no API-key
          form (a provider that also accepts keys is reached through OAuth). */}
      {oauth === undefined && <AddAccount provider={provider} client={client} mutate={mutate} />}
    </div>
  );
}

/** The accounts card shared by every section (API keys, env, OAuth). */
function ProviderAccounts({
  provider,
  client,
  mutate,
  oauth = false,
  onReconnectAccount,
}: {
  provider: ProviderInfo;
  client: BaiClient;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  /** True when the provider is OAuth-capable (changes the empty-state hint). */
  oauth?: boolean;
  /** Reconnect one specific OAuth account (per-account, in place). */
  onReconnectAccount?: (accountId: string) => void;
}) {
  return (
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
        <p className="section-lede">
          {oauth ? "No accounts yet — use Connect above." : "No accounts yet — add one below."}
        </p>
      )}
      {provider.accounts.length > 0 && (
        <ul className="accounts">
          {provider.accounts.map((a) => (
            <li key={a.id}>
              <span>
                {a.label} <span className="dim">({a.id})</span>
                {a.baseUrl !== undefined && <span className="dim"> · {a.baseUrl}</span>}
              </span>
              <span className="dim">
                {a.source === "env" ? "from environment" : a.source === "oauth" ? "oauth" : "api key"}
              </span>
              {a.source !== "env" && a.source === "oauth" && onReconnectAccount !== undefined && (
                <Button variant="outline" size="sm" onClick={() => onReconnectAccount(a.id)}>
                  Reconnect
                </Button>
              )}
              {a.source !== "env" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void mutate(
                      async () => {
                        await client.putConfig({ models: { defaultAccount: { [provider.id]: a.id } } });
                      },
                      `Default account for ${provider.name}: ${a.label}`,
                    );
                  }}
                >
                  Use by default
                </Button>
              )}
              {a.source !== "env" && (
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

const WEB_SEARCH_PROVIDER_OPTIONS = [
  { value: "auto", label: "Automatic (Exa → Parallel → DuckDuckGo)" },
  { value: "exa", label: "Exa" },
  { value: "parallel", label: "Parallel" },
  { value: "ddgs", label: "DuckDuckGo (last resort)" },
];

const WEB_SEARCH_PROVIDER_LABELS: Record<string, string> = {
  exa: "Exa",
  parallel: "Parallel",
  ddgs: "DuckDuckGo",
};

/**
 * Web Search section: provider selection, keyless-fallback toggle, and a
 * read-only status line (which keys the server has detected, which providers
 * are usable now). Self-loads its status and refetches after each save.
 */
function WebSearchPane({ client, onNotice }: { client: BaiClient; onNotice: OnNotice }) {
  const [status, setStatus] = useState<WebSearchStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async (): Promise<void> => {
    try {
      setStatus(await client.getWebSearchStatus());
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: { provider?: WebSearchProviderId; keylessFallback?: boolean }): Promise<void> => {
    setSaving(true);
    try {
      await client.putConfig({ tools: { webSearch: patch } });
      await load();
      onNotice("Web search settings saved");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  };

  if (status === null) {
    return <p className="dim">Loading…</p>;
  }

  const available = status.available.map((name) => WEB_SEARCH_PROVIDER_LABELS[name] ?? name).join(", ");
  const keyLine = (label: string, detected: boolean): string => `${label}: ${detected ? "key detected" : "no key"}`;

  return (
    <>
      <PageHeader title="Web Search" />
      <Card>
        <SectionHeader
          title="Provider"
          lede="Which backend web.search uses. Exa and Parallel work without a key (public free tiers, rate-limited) or with EXA_API_KEY / PARALLEL_API_KEY for higher limits. DuckDuckGo is a keyless last resort."
        />
        <Field label="Provider">
          <Select
            options={WEB_SEARCH_PROVIDER_OPTIONS}
            value={status.provider}
            disabled={saving}
            onChange={(value) => void save({ provider: value as WebSearchProviderId })}
            ariaLabel="Web search provider"
          />
        </Field>
        <ToggleRow
          checked={status.keylessFallback}
          onChange={(checked) => void save({ keylessFallback: checked })}
          title="Keyless fallback"
          description="Use the public Exa/Parallel free tiers (and DuckDuckGo) when no API key is configured."
        />
        <p className="dim">
          {keyLine("Exa", status.keys.exa)} · {keyLine("Parallel", status.keys.parallel)}
        </p>
        <p className="dim">Available now: {available.length > 0 ? available : "none"}</p>
      </Card>
    </>
  );
}

const MCP_STATE_LABELS: Record<McpServerInfo["state"], string> = {
  connected: "connected",
  connecting: "connecting",
  failed: "failed",
  disabled: "disabled",
  needs_auth: "needs authorization",
};

/**
 * Integrations section: installed MCP servers (status, enable/disable,
 * authorize, retry, remove) plus the curated catalog. Installing a catalog
 * entry writes a drop-in file under ~/.config/bai/mcp/ and starts OAuth.
 */
function IntegrationsPane({ client, onNotice }: { client: BaiClient; onNotice: OnNotice }) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [authName, setAuthName] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [serverModal, setServerModal] = useState<
    | { mode: "add" }
    | { mode: "edit"; server: { name: string; source: McpServerSource; config: MCPServerConfig } }
    | null
  >(null);

  const load = async (): Promise<void> => {
    try {
      const [nextServers, nextCatalog] = await Promise.all([client.getMcpServers(), client.getMcpCatalog()]);
      setServers(nextServers);
      setCatalog(nextCatalog);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While authorization is pending, poll so the server-side loopback callback
  // flips the row to connected without a manual paste.
  useEffect(() => {
    if (authName === null) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await client.getMcpServers();
          setServers(next);
          if (next.find((s) => s.name === authName)?.state === "connected") {
            onNotice(`${authName} authorized`);
            setAuthName(null);
            setAuthUrl(null);
            setAuthCode("");
          }
        } catch {
          // transient — keep polling
        }
      })();
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authName]);

  const run = async (key: string, fn: () => Promise<void>, ok: string): Promise<void> => {
    setBusy(key);
    try {
      await fn();
      await load();
      onNotice(ok);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const beginAuth = (name: string, url: string): void => {
    window.open(url, "_blank", "noopener,noreferrer");
    setAuthName(name);
    setAuthUrl(url);
    setAuthCode("");
    onNotice("Authorize in the browser window — this page updates automatically when it completes.");
  };

  const authorize = async (name: string): Promise<void> => {
    setBusy(name);
    try {
      beginAuth(name, await client.startMcpAuth(name));
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const install = async (name: string): Promise<void> => {
    setBusy(`install:${name}`);
    try {
      const url = await client.installMcpCatalogEntry(name);
      await load();
      if (url !== undefined) beginAuth(name, url);
      else onNotice(`Installed ${name}`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const finishAuth = async (): Promise<void> => {
    if (authName === null || authCode.trim().length === 0) return;
    const name = authName;
    await run(name, () => client.finishMcpAuth(name, authCode.trim()), `${name} authorized`);
    setAuthName(null);
    setAuthUrl(null);
    setAuthCode("");
  };

  const openEdit = async (name: string): Promise<void> => {
    setBusy(`edit:${name}`);
    try {
      setServerModal({ mode: "edit", server: await client.getMcpServer(name) });
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  if (servers === null) {
    return <p className="dim">Loading…</p>;
  }

  const installed = new Set(servers.map((s) => s.name));

  return (
    <>
      <PageHeader title="Integrations" />
      {authName !== null && (
        <Card>
          <SectionHeader
            title={`Authorize ${authName}`}
            lede="A browser window opened — authorize there and this page will update automatically. If the browser cannot reach the local callback, paste the authorization code (or the full callback URL) instead."
          />
          {authUrl !== null && (
            <p>
              <a href={authUrl} target="_blank" rel="noopener noreferrer">
                Reopen the authorization page
              </a>
            </p>
          )}
          <Field label="Authorization code">
            <TextInput value={authCode} placeholder="paste code…" onChange={(e) => setAuthCode(e.target.value)} />
          </Field>
          <div>
            <Button
              type="button"
              variant="primary"
              disabled={authCode.trim().length === 0 || busy !== null}
              onClick={() => void finishAuth()}
            >
              Finish authorization
            </Button>{" "}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setAuthName(null);
                setAuthUrl(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* --- Catalog (first, height-capped so it never buries the servers) --- */}
      <h3 className="settings-subheading">Catalog</h3>
      <p className="section-lede">
        Official vendor-hosted MCP servers. Install writes a drop-in file in ~/.config/bai/mcp/, then starts OAuth.
      </p>
      <div className="provider-accordion catalog-scroll">
        {catalog.map((entry) => (
          <div key={entry.name} className="mcp-row">
            <div>
              <strong>{entry.title}</strong> <span className="mcp-row-meta">{entry.description}</span>
            </div>
            <div className="mcp-row-actions">
              <Button
                type="button"
                variant={installed.has(entry.name) ? "ghost" : "primary"}
                disabled={busy !== null || installed.has(entry.name)}
                onClick={() => void install(entry.name)}
              >
                {installed.has(entry.name) ? "Installed" : "Install"}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* --- Custom MCP servers (files in ~/.config/bai/mcp/ or config.json) --- */}
      <h3 className="settings-subheading">Custom MCP Servers</h3>
      <p className="section-lede">
        Your own servers — files in ~/.config/bai/mcp/ or config.json. Their tools appear as{" "}
        <code>mcp/&lt;server&gt;/&lt;tool&gt;</code>.
      </p>
      <div className="provider-actions">
        <Button variant="outline" onClick={() => setServerModal({ mode: "add" })}>
          + Add a custom MCP server
        </Button>
      </div>
      {servers.length === 0 ? (
        <p className="dim provider-empty">No MCP servers yet. Install one above, or drop a file into ~/.config/bai/mcp/.</p>
      ) : (
        <div className="provider-accordion">
          {servers.map((server) => (
            <div key={server.name} className="mcp-row">
              <div>
                <strong>{server.name}</strong>{" "}
                <span className="mcp-row-meta">
                  {MCP_STATE_LABELS[server.state]} · {server.transport} · {server.tools} tool
                  {server.tools === 1 ? "" : "s"} · {server.source === "file" ? "file" : "config.json"}
                  {server.error !== undefined ? ` · ${server.error}` : ""}
                </span>
              </div>
              <div className="mcp-row-actions">
                <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void openEdit(server.name)}>
                  Edit
                </Button>
                {server.state === "needs_auth" && (
                  <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void authorize(server.name)}>
                    Authorize
                  </Button>
                )}
                {server.state === "failed" && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void run(server.name, () => client.reconnectMcpServer(server.name), "Reconnect requested")}
                  >
                    Retry
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(
                      server.name,
                      () => client.setMcpServerEnabled(server.name, server.state === "disabled"),
                      server.state === "disabled" ? "Enabled" : "Disabled",
                    )
                  }
                >
                  {server.state === "disabled" ? "Enable" : "Disable"}
                </Button>
                {server.source === "file" && (
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy !== null}
                    onClick={() => void run(server.name, () => client.deleteMcpServer(server.name), `Removed ${server.name}`)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {serverModal !== null && (
        <McpServerModal
          client={client}
          {...(serverModal.mode === "edit" ? { server: serverModal.server } : {})}
          onClose={() => setServerModal(null)}
          onSaved={() => void load()}
          onNotice={onNotice}
        />
      )}
    </>
  );
}
