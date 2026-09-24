import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Pencil, Trash2 } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type {
  AgentInfo,
  JobsConfig,
  MCPServerConfig,
  McpCatalogEntry,
  McpServerInfo,
  McpServerRoleStatus,
  McpServerSource,
  MediaGenConfig,
  MediaProviderInfo,
  VideoProviderInfo,
  ProviderFileInfo,
  MediaParamSpec,
  MediaParamValue,
  MediaTagCount,
  OAuthProviderInfo,
  ProviderInfo,
  ProviderListResponse,
  WebSearchProviderId,
  WebSearchStatus,
} from "@bai/shared";
import {
  coerceMediaParams,
  formatTimeAgo,
  isZdrCapableModel,
  sortModelsZdrFirst,
  THEME_OPTIONS,
} from "@bai/shared";
import { partitionProviders, sortProviders } from "./provider-utils";
import { modelOptionHint, videoModelOptionHint } from "./media-model-hint";
import { AgentModal } from "./agent-picker";
import { ModelModal } from "./model-picker";
import { ModelCapabilityBadges } from "./model-capabilities";
import { OAuthModal } from "./oauth-modal";
import { CustomProviderModal } from "./custom-provider-form";
import { ProviderFileModal } from "./provider-file-form";
import { McpServerModal } from "./mcp-server-form";
import { BrandIcon, CategoryIcon } from "./brand-icon";
import { ProviderIcon } from "./provider-icon";
import {
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  Field,
  IconButton,
  ListItem,
  MediaParamsForm,
  PageHeader,
  PickerTrigger,
  SectionHeader,
  Select,
  SubNav,
  SubNavItem,
  TagInput,
  TextInput,
  ToggleRow,
} from "./components";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Settings, divided into sections (the nested sidebar's entries): General,
 * Model Providers, Image Generation, Web Search, Integrations. Each section
 * renders one scrollable heading-content page in the main pane:
 *
 * - General — display name (injected into every agent's <env> block), theme,
 *   default agent + default model (what new sessions resolve) — both picked
 *   through the SAME modals the chat header uses (AgentModal / ModelModal),
 *   so one picker everywhere. (Formerly a separate User section.)
 * - Model Providers — the prefer-ZDR preference, ALL catalog providers as
 *   expandable cards (accounts, remove, add-account), and the Video Gen
 *   defaults (provider · account · model).
 * - Image Generation — the image workbench defaults (provider · account ·
 *   model) and the media job limits (concurrent generations, timeout,
 *   retries, backoff).
 *
 * Same endpoints the TUI's ctrl+p wizard uses — add an account here and the
 * TUI's picker picks it up live via provider.updated; every setting writes
 * the global config layer via PUT /api/config and propagates to all surfaces
 * via config.updated. Feedback rides the shared toast (no inline banners).
 */

/** The settings sections (the nested sidebar's entries). */
export type SettingsSection =
  | "general"
  | "providers"
  | "image"
  | "video"
  | "webSearch"
  | "integrations";

/** Nested-sidebar list: the settings sections. */
export function SettingsNav({
  selected,
  onSelect,
}: {
  selected: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}) {
  const entries: { id: SettingsSection; title: string; dim: string }[] = [
    { id: "general", title: "General", dim: "name · agent · model" },
    { id: "providers", title: "Model Providers", dim: "accounts · media gen" },
    { id: "image", title: "Image Generation", dim: "defaults · concurrency" },
    { id: "video", title: "Video Generation", dim: "workflows · defaults" },
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
  routerEnabled,
  defaultAgent,
  imageGen,
  videoGen,
  jobs,
  theme,
  onOpenThemePicker,
  onNotice,
}: {
  client: BaiClient;
  /** Null until the first engagement fetch lands (General/providers need it). */
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
  /** config router.enabled — the Model Providers "Run as router" toggle. */
  routerEnabled?: boolean;
  defaultAgent?: string;
  imageGen?: MediaGenConfig;
  videoGen?: MediaGenConfig;
  /** Media job-runtime limits (config jobs) — the Image Generation pane. */
  jobs?: JobsConfig;
  /** Active theme id (built-in or custom file stem) — the General pane's theme card. */
  theme: string;
  /** Open the theme picker modal (App-owned). */
  onOpenThemePicker: () => void;
  /** Toast feedback (success/error). */
  onNotice: OnNotice;
}) {
  const mutate = async (
    fn: () => Promise<void>,
    okMessage: string,
  ): Promise<void> => {
    try {
      await fn();
      await refresh();
      onNotice(okMessage);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

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
          userName={userName}
          theme={theme}
          onOpenThemePicker={onOpenThemePicker}
          mutate={mutate}
        />
      ) : section === "image" ? (
        <ImageGenPane
          client={client}
          list={list}
          imageGen={imageGen}
          jobs={jobs}
          mutate={mutate}
          onNotice={onNotice}
        />
      ) : section === "video" ? (
        <VideoGenPane
          client={client}
          list={list}
          videoGen={videoGen}
          jobs={jobs}
          mutate={mutate}
          onNotice={onNotice}
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
          routerEnabled={routerEnabled}
        />
      )}
    </div>
  );
}

/** Display name card (folded into General): agents see it via the <env> block. */
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
    void mutate(async () => {
      await client.putConfig({ user: { name: trimmed } });
    }, `User name set to ${trimmed}`);
  };

  return (
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
      <Button
        type="submit"
        variant="primary"
        disabled={name.trim().length === 0}
      >
        Save name
      </Button>
    </Card>
  );
}

/**
 * General section: display name (was its own User section), the UI theme,
 * and the defaults new sessions resolve (agent, then model).
 */
function GeneralPane({
  client,
  list,
  refresh,
  agents,
  refreshAgents,
  defaultAgent,
  preferZdr,
  userName,
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
  /** Config display name — the User name card (merged from the old User section). */
  userName?: string;
  theme: string;
  onOpenThemePicker: () => void;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  return (
    <>
      <PageHeader title="General" />
      <UserPane client={client} userName={userName} mutate={mutate} />
      <ThemeCard theme={theme} onOpenThemePicker={onOpenThemePicker} />
      <DefaultAgentCard
        client={client}
        agents={agents}
        refreshAgents={refreshAgents}
        current={defaultAgent}
        mutate={mutate}
      />
      <DefaultModelCard
        client={client}
        list={list}
        preferZdr={preferZdr}
        refresh={refresh}
        mutate={mutate}
      />
    </>
  );
}

/** UI theme (config theme): shows the active theme, opens the picker modal. */
function ThemeCard({
  theme,
  onOpenThemePicker,
}: {
  theme: string;
  onOpenThemePicker: () => void;
}) {
  const label =
    THEME_OPTIONS.find((opt) => opt.value === theme)?.label ?? theme;
  return (
    <Card className="theme-card">
      <SectionHeader
        title="Theme"
        lede={
          <>
            One theme everywhere — the terminal picks it up live
            (config-updated), and this browser remembers it for the next boot.
            Current: {label}
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
        lede={
          <>
            Used by sessions that select none. Current:{" "}
            {current ?? "build (built-in default)"}
          </>
        }
      />
      <div>
        <PickerTrigger
          label="agent"
          value={effective}
          onClick={() => setPickerOpen(true)}
          ariaLabel={`default agent: ${effective}`}
        />
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
            void mutate(async () => {
              await client.putConfig({ agents: { default: name } });
            }, `Default agent set to ${name}`);
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
  const currentModel = list.providers
    .flatMap((p) => p.models)
    .find((m) => m.id === current);

  const saveCustom = (e: FormEvent): void => {
    e.preventDefault();
    const value = custom.trim();
    if (value.length === 0) return;
    void mutate(async () => {
      await client.putConfig({ models: { default: value } });
    }, `Default model set to ${value}`);
    setCustom("");
  };

  return (
    <Card as="form" onSubmit={saveCustom}>
      <SectionHeader
        title="Default model"
        lede={
          <>
            Used by new sessions; per-session picks (chat header) override it.
            Current: {list.default.model ?? "stub/echo"}
          </>
        }
      />
      <div>
        <PickerTrigger
          label="model"
          value={current}
          onClick={() => setPickerOpen(true)}
          ariaLabel={`default model: ${current}`}
          trailing={
            currentModel !== undefined ? (
              <ModelCapabilityBadges model={currentModel} />
            ) : undefined
          }
        />
      </div>
      <div className="form-grid">
        <Field
          label="Or any model id"
          hint="(provider/model — for ids outside the catalog)"
        >
          <TextInput
            value={custom}
            placeholder="provider/model"
            onChange={(e) => setCustom(e.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={custom.trim().length === 0}
        >
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

/** Model Providers section: ZDR preference, all providers, video-gen defaults. */
function ProvidersPane({
  client,
  list,
  fetching,
  mutate,
  refresh,
  onNotice,
  preferZdr,
  routerEnabled,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  fetching: boolean;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  refresh: () => Promise<void>;
  onNotice: (message: string, kind?: "success" | "error") => void;
  preferZdr?: boolean;
  routerEnabled?: boolean;
}) {
  // Single-expanded accordion: one provider's accounts + add form at a time
  // keeps the 200+ catalog page light (forms mount lazily on expand).
  const [expanded, setExpanded] = useState<string | null>(null);
  const [oauth, setOauth] = useState<OAuthProviderInfo[]>([]);
  // OAuth target + intent: `connect` names/writes the default account, `add`
  // creates a new one, `reconnect` refreshes one specific account id.
  const [oauthTarget, setOauthTarget] = useState<{
    provider: ProviderInfo;
    intent: "connect" | "add" | "reconnect";
    accountId?: string;
  } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [pendingCustom, setPendingCustom] = useState<ProviderInfo | null>(null);
  const sorted = sortProviders(list.providers);
  const oauthById = new Map(oauth.map((o) => [o.id, o]));
  const {
    custom,
    oauth: oauthProviders,
    catalog,
  } = partitionProviders(sorted, oauthById.keys());

  const loadOauth = (): void => {
    void client
      .oauthProviders()
      .then(setOauth)
      .catch(() => undefined);
  };
  useEffect(loadOauth, [client]);

  const removeCustom = (p: ProviderInfo): void => {
    void mutate(() => client.deleteCustomProvider(p.id), `Removed ${p.name}`);
  };

  // File-defined providers (~/.config/bai/providers/), hot-reloaded.
  const [providerFileList, setProviderFileList] = useState<ProviderFileInfo[]>([]);
  const [fileModal, setFileModal] = useState<{ existing?: ProviderFileInfo } | null>(null);
  const reloadProviderFiles = useCallback((): void => {
    void client
      .providerFiles()
      .then(setProviderFileList)
      .catch(() => setProviderFileList([]));
  }, [client]);
  useEffect(reloadProviderFiles, [reloadProviderFiles]);

  // Manual catalog refresh: force the server's models.dev pull (bypasses its
  // TTL) — `mutate` refetches the list and toasts the outcome.
  const [catalogBusy, setCatalogBusy] = useState(false);
  const refreshCatalog = useCallback((): void => {
    if (catalogBusy) return;
    setCatalogBusy(true);
    void mutate(() => client.refreshProviderCatalog().then(() => undefined), "Catalog refreshed").finally(() =>
      setCatalogBusy(false),
    );
  }, [catalogBusy, client, mutate]);

  return (
    <>
      <PageHeader title="Model Providers" />
      <ZdrToggle client={client} preferZdr={preferZdr} mutate={mutate} />
      <RouterToggle client={client} routerEnabled={routerEnabled} mutate={mutate} />

      {/* --- Provider files (~/.config/bai/providers/) -------------------- */}
      <h3 className="settings-subheading">Provider Files</h3>
      <p className="section-lede">
        Drop-in JSON files in <code>~/.config/bai/providers/</code>, hot-reloaded.
        Each file's <code>providerType</code> decides where it appears (chat and/or
        image).
      </p>
      <div className="provider-actions">
        <Button variant="outline" onClick={() => setFileModal({})}>
          + Add provider file
        </Button>
      </div>
      {providerFileList.length === 0 ? (
        <p className="dim provider-empty">No provider files yet.</p>
      ) : (
        <ul className="accounts">
          {providerFileList.map((f) => (
            <li key={f.id}>
              <span>
                {f.name} <span className="dim">({f.id})</span> —{" "}
                <i>{f.providerType.join(", ")}</i>
              </span>
              <span className="key-actions">
                <IconButton
                  label={`Edit ${f.name}`}
                  hint="Edit provider file"
                  onClick={() => setFileModal({ existing: f })}
                >
                  <Pencil size={14} />
                </IconButton>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* --- Custom providers (config-defined endpoints) ------------------- */}
      <h3 className="settings-subheading">Custom Providers</h3>
      <p className="section-lede">
        Your own endpoints — any OpenAI-compatible, Anthropic, or Responses
        gateway.
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
              {...(oauthById.get(p.id) !== undefined
                ? { oauth: oauthById.get(p.id) as OAuthProviderInfo }
                : {})}
              onConnect={() =>
                setOauthTarget({ provider: p, intent: "connect" })
              }
              onReconnectAccount={(accountId) =>
                setOauthTarget({ provider: p, intent: "reconnect", accountId })
              }
              onAddAccount={() =>
                setOauthTarget({ provider: p, intent: "add" })
              }
              onDeleteCustom={() => setPendingCustom(p)}
            />
          ))}
        </div>
      )}

      {/* --- OAuth providers (subscription / local logins) ----------------- */}
      <h3 className="settings-subheading">OAuth Providers</h3>
      <p className="section-lede">
        Sign in with a subscription or local credential — tokens are stored
        server-side.
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
              onConnect={() =>
                setOauthTarget({ provider: p, intent: "connect" })
              }
              onReconnectAccount={(accountId) =>
                setOauthTarget({ provider: p, intent: "reconnect", accountId })
              }
              onAddAccount={() =>
                setOauthTarget({ provider: p, intent: "add" })
              }
            />
          ))}
        </div>
      )}

      {/* --- Catalog list (models.dev ⊕ curated overlay), height-capped ---- */}
      <h3 className="settings-subheading">Catalog List</h3>
      <p className="section-lede">
        Every other provider the catalog knows — connect one by adding an
        account. Connected first.
      </p>
      <div className="provider-actions">
        <span className="dim" style={{ alignSelf: "center" }}>
          models.dev · updated {formatTimeAgo(list.catalogUpdatedAt ?? 0)}
          {fetching ? " · updating…" : ""}
        </span>
        <Button variant="outline" loading={catalogBusy} onClick={refreshCatalog}>
          Refresh catalog
        </Button>
      </div>
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
            {...(oauthById.get(p.id) !== undefined
              ? { oauth: oauthById.get(p.id) as OAuthProviderInfo }
              : {})}
            onConnect={() => setOauthTarget({ provider: p, intent: "connect" })}
            onReconnectAccount={(accountId) =>
              setOauthTarget({ provider: p, intent: "reconnect", accountId })
            }
          />
        ))}
      </div>

      {oauthTarget !== null && (
        <OAuthModal
          client={client}
          provider={oauthTarget.provider.id}
          providerName={oauthTarget.provider.name}
          defaultAccount={
            oauthById.get(oauthTarget.provider.id)?.defaultAccount
          }
          intent={oauthTarget.intent}
          {...(oauthTarget.accountId !== undefined
            ? { accountId: oauthTarget.accountId }
            : {})}
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
      {fileModal !== null && (
        <ProviderFileModal
          client={client}
          {...(fileModal.existing !== undefined ? { existing: fileModal.existing } : {})}
          onClose={() => setFileModal(null)}
          onSaved={() => {
            reloadProviderFiles();
            void refresh();
          }}
          onNotice={onNotice}
        />
      )}
      <ConfirmDialog
        open={pendingCustom !== null}
        title="Remove custom provider?"
        body={
          <>
            Remove <strong>{pendingCustom?.name}</strong> ({pendingCustom?.id})
            and its configured accounts? This cannot be undone.
          </>
        }
        confirmLabel="Remove"
        onCancel={() => setPendingCustom(null)}
        onConfirm={() => {
          const p = pendingCustom;
          setPendingCustom(null);
          if (p !== null) removeCustom(p);
        }}
      />
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
      {/* @ui-raw: accordion header needs aria-expanded/aria-controls; SubNavItem
          does not forward those attributes, so keep the raw button for ARIA. */}
      <button
        type="button"
        className={expanded ? "provider-item active" : "provider-item"}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`provider-detail-${provider.id}`}
      >
        <span className="provider-head">
          <ProviderIcon
            id={provider.id}
            name={provider.name}
            adapter={provider.adapter}
            size={16}
          />
          <span className="title">{provider.name}</span>
        </span>
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
            {...(onReconnectAccount !== undefined
              ? { onReconnectAccount }
              : {})}
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
          on
            ? "Prefer ZDR-capable models: on"
            : "Prefer ZDR-capable models: off",
        );
      }}
    />
  );
}

/**
 * Run as router (config router.enabled) — serve the OpenAI-compatible gateway
 * (`/v1/*`) and `/api/help` from this server. Applies live; `bai --router`
 * always enables it.
 */
function RouterToggle({
  client,
  routerEnabled,
  mutate,
}: {
  client: BaiClient;
  routerEnabled?: boolean;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  return (
    <ToggleRow
      checked={routerEnabled !== false}
      title="Run as router"
      description={
        "Serve the OpenAI-compatible router gateway (/v1) and /api/help from this server. " +
        "Applies live; bai --router always enables it."
      }
      onChange={(on) => {
        void mutate(
          async () => {
            await client.putConfig({ router: { enabled: on } });
          },
          on ? "Run as router: on" : "Run as router: off",
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
      {oauth === undefined && (
        <AddAccount provider={provider} client={client} mutate={mutate} />
      )}
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
  const [pending, setPending] = useState<{ id: string; label: string } | null>(
    null,
  );
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
          {oauth
            ? "No accounts yet — use Connect above."
            : "No accounts yet — add one below."}
        </p>
      )}
      {provider.accounts.length > 0 && (
        <ul className="accounts">
          {provider.accounts.map((a) => (
            <li key={a.id}>
              <span>
                {a.label} <span className="dim">({a.id})</span>
                {a.baseUrl !== undefined && (
                  <span className="dim"> · {a.baseUrl}</span>
                )}
              </span>
              <span className="dim">
                {a.source === "env"
                  ? "from environment"
                  : a.source === "oauth"
                    ? "oauth"
                    : "api key"}
              </span>
              {a.source !== "env" &&
                a.source === "oauth" &&
                onReconnectAccount !== undefined && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onReconnectAccount(a.id)}
                  >
                    Reconnect
                  </Button>
                )}
              {a.source !== "env" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void mutate(async () => {
                      await client.putConfig({
                        models: { defaultAccount: { [provider.id]: a.id } },
                      });
                    }, `Default account for ${provider.name}: ${a.label}`);
                  }}
                >
                  Use by default
                </Button>
              )}
              {a.source !== "env" && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setPending({ id: a.id, label: a.label })}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        title="Remove account?"
        body={
          <>
            Remove <strong>{pending?.label}</strong> from{" "}
            <strong>{provider.name}</strong>? This cannot be undone.
          </>
        }
        confirmLabel="Remove"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const p = pending;
          setPending(null);
          if (p !== null) {
            void mutate(
              () => client.deleteAccount(provider.id, p.id),
              `Removed ${p.label}`,
            );
          }
        }}
      />
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
          <TextInput
            value={accountId}
            placeholder="personal, work…"
            onChange={(e) => setAccountId(e.target.value)}
          />
        </Field>
        <Field label="Label">
          <TextInput
            value={label}
            placeholder="display name"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="API key">
          <TextInput
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        {/* Catalog providers have known endpoints; config/account-only
            providers without a baseUrl must be told where to send requests. */}
        {provider.baseUrl === undefined && provider.source !== "catalog" && (
          <Field label="Base URL">
            <TextInput
              value={baseUrl}
              placeholder="https://…/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
        )}
      </div>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={accountId.length === 0 || key.length === 0}
        >
          Add account
        </Button>
      </div>
    </Card>
  );
}

/**
 * Image Generation section: the default provider/model (the MediaGenForm) plus
 * the media job-runtime limits (how many generations run at once).
 */
function ImageGenPane({
  client,
  list,
  imageGen,
  jobs,
  mutate,
  onNotice,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  imageGen?: MediaGenConfig;
  jobs?: JobsConfig;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  onNotice: (message: string, kind?: "success" | "error") => void;
}) {
  return (
    <>
      <PageHeader
        title="Image Generation"
        lede="Where bai generates images: the provider API keys, the default provider/model, and how many generations run at once."
      />
      <ImageProvidersCard
        client={client}
        list={list}
        config={imageGen}
        kind="image"
        mutate={mutate}
        onNotice={onNotice}
      />
      <MediaGenForm
        kind="imageGen"
        title="Default model"
        client={client}
        list={list}
        config={imageGen}
        mutate={mutate}
      />
      <ImageDefaultsParamsForm
        client={client}
        imageGen={imageGen}
        mutate={mutate}
      />
      <JobsLimitsForm client={client} jobs={jobs} mutate={mutate} />
    </>
  );
}

/**
 * Video Generation settings: the provider API keys (video-only vendors hidden
 * from the LLM Model Providers pane), the default provider/model, the default
 * workflow parameters/tags, and the media job limits (video jobs get a longer
 * timeout than images).
 */
function VideoGenPane({
  client,
  list,
  videoGen,
  jobs,
  mutate,
  onNotice,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  videoGen?: MediaGenConfig;
  jobs?: JobsConfig;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  onNotice: (message: string, kind?: "success" | "error") => void;
}) {
  return (
    <>
      <PageHeader
        title="Video Generation"
        lede="Where bai generates videos: the provider API keys, the default provider/model, and the media job limits (video renders get a longer timeout)."
      />
      <ImageProvidersCard
        client={client}
        list={list}
        config={videoGen}
        kind="video"
        mutate={mutate}
        onNotice={onNotice}
      />
      <MediaGenForm
        kind="videoGen"
        title="Default model"
        client={client}
        list={list}
        config={videoGen}
        mutate={mutate}
      />
      <VideoDefaultsParamsForm
        client={client}
        videoGen={videoGen}
        mutate={mutate}
      />
      <JobsLimitsForm client={client} jobs={jobs} mutate={mutate} />
    </>
  );
}

/**
 * Video default generation parameters + tags (config videoGen.params/.tags).
 * The controls come from the default provider/model's workflow vocabulary, so
 * the form always matches the adapter. The agent `video.generate` tool and the
 * Video page both fall back to these.
 */
function VideoDefaultsParamsForm({
  client,
  videoGen,
  mutate,
}: {
  client: BaiClient;
  videoGen?: MediaGenConfig;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const provider = videoGen?.provider;
  const model = videoGen?.model;
  const [specs, setSpecs] = useState<MediaParamSpec[]>([]);
  const [params, setParams] = useState<Record<string, MediaParamValue>>({});
  const [tags, setTags] = useState<string[]>(videoGen?.tags ?? []);
  const [tagOptions, setTagOptions] = useState<MediaTagCount[]>([]);

  useEffect(() => {
    let cancelled = false;
    void client
      .videoCapabilities(provider, model)
      .then((res) => {
        if (cancelled) return;
        setSpecs(res.capabilities.params);
        setParams(coerceMediaParams(res.capabilities.params, { ...(videoGen?.params ?? {}) }));
      })
      .catch(() => {
        if (!cancelled) setSpecs([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, provider, model]);

  useEffect(() => {
    let cancelled = false;
    void client
      .videoTags(undefined, 200)
      .then((res) => {
        if (!cancelled) setTagOptions(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void mutate(async () => {
      await client.putConfig({ videoGen: { params, tags } });
    }, "Video default parameters saved");
  };

  return (
    <Card as="form" onSubmit={submit}>
      <SectionHeader
        title="Default parameters"
        lede="Applied to every generation (the Video page and the agent video.generate tool) unless overridden. Controls come from the selected model."
      />
      {specs.length > 0 ? (
        <MediaParamsForm specs={specs} value={params} onChange={setParams} />
      ) : (
        <p className="dim">Set a provider and model above to configure its parameters.</p>
      )}
      <Field label="Default tags" hint="(added to every generation)">
        <TagInput value={tags} onChange={setTags} suggestions={tagOptions} />
      </Field>
      <div>
        <Button type="submit" variant="primary">
          Save defaults
        </Button>
      </div>
    </Card>
  );
}

/**
 * Default generation parameters + tags (config imageGen.params/.tags). The
 * parameter controls come from the selected model's capability spec, so the
 * form always matches the provider. The agent `image.generate` tool and the
 * Image page both fall back to these.
 */
function ImageDefaultsParamsForm({
  client,
  imageGen,
  mutate,
}: {
  client: BaiClient;
  imageGen?: MediaGenConfig;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const provider = imageGen?.provider;
  const model = imageGen?.model;
  const [specs, setSpecs] = useState<MediaParamSpec[]>([]);
  const [params, setParams] = useState<Record<string, MediaParamValue>>({});
  const [tags, setTags] = useState<string[]>(imageGen?.tags ?? []);
  const [tagOptions, setTagOptions] = useState<MediaTagCount[]>([]);

  useEffect(() => {
    let cancelled = false;
    void client
      .imageCapabilities(provider, model)
      .then((res) => {
        if (cancelled) return;
        setSpecs(res.capabilities.params);
        // Seed declared defaults, then the saved config values on top.
        const seeded = coerceMediaParams(res.capabilities.params, {
          ...(imageGen?.params ?? {}),
        });
        setParams(seeded);
      })
      .catch(() => {
        if (!cancelled) setSpecs([]);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the configured provider/model changes; params are re-seeded
    // from config inside (the form remounts on model change via App refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, provider, model]);

  useEffect(() => {
    let cancelled = false;
    void client
      .imageTags(undefined, 200)
      .then((res) => {
        if (!cancelled) setTagOptions(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void mutate(async () => {
      await client.putConfig({ imageGen: { params, tags } });
    }, "Image default parameters saved");
  };

  return (
    <Card as="form" onSubmit={submit}>
      <SectionHeader
        title="Default parameters"
        lede="Applied to every generation (the Image page and the agent image.generate tool) unless overridden. Controls come from the selected model."
      />
      {specs.length > 0 ? (
        <MediaParamsForm specs={specs} value={params} onChange={setParams} />
      ) : (
        <p className="dim">
          Set a provider and model above to configure its parameters.
        </p>
      )}
      <Field label="Default tags" hint="(added to every generation)">
        <TagInput value={tags} onChange={setTags} suggestions={tagOptions} />
      </Field>
      <div>
        <Button type="submit" variant="primary">
          Save defaults
        </Button>
      </div>
    </Card>
  );
}

/**
 * Media job-runtime limits (config jobs): how many generations run in
 * parallel, and the per-job reliability envelope (timeout / attempts /
 * backoff). Applies to image (and future video) jobs.
 */
function JobsLimitsForm({
  client,
  jobs,
  mutate,
}: {
  client: BaiClient;
  jobs?: JobsConfig;
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
}) {
  const [concurrency, setConcurrency] = useState(
    String(jobs?.concurrency ?? 3),
  );
  const [timeoutMs, setTimeoutMs] = useState(
    String(jobs?.timeoutMs ?? 180_000),
  );
  const [videoTimeoutMs, setVideoTimeoutMs] = useState(
    String(jobs?.videoTimeoutMs ?? 900_000),
  );
  const [maxAttempts, setMaxAttempts] = useState(
    String(jobs?.maxAttempts ?? 3),
  );
  const [backoffMs, setBackoffMs] = useState(String(jobs?.backoffMs ?? 1500));

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const patch: JobsConfig = {
      concurrency: clampInt(concurrency, 1, 10, 3),
      timeoutMs: clampInt(timeoutMs, 1000, 3_600_000, 180_000),
      videoTimeoutMs: clampInt(videoTimeoutMs, 1000, 3_600_000, 900_000),
      maxAttempts: clampInt(maxAttempts, 1, 10, 3),
      backoffMs: clampInt(backoffMs, 0, 600_000, 1500),
    };
    void mutate(async () => {
      await client.putConfig({ jobs: patch });
    }, `Media generation limits saved (${patch.concurrency} concurrent)`);
  };

  return (
    <Card as="form" onSubmit={submit}>
      <SectionHeader
        title="Concurrent generations"
        lede="How many image generations run at once, and the per-job reliability envelope (timeout, retries, backoff)."
      />
      <div className="form-grid">
        <Field label="Concurrent generations" hint="(1–10, default 3)">
          <TextInput
            type="number"
            min={1}
            max={10}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
          />
        </Field>
        <Field label="Timeout (ms)" hint="(per image job)">
          <TextInput
            type="number"
            min={1000}
            max={3_600_000}
            step={1000}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
          />
        </Field>
        <Field label="Video timeout (ms)" hint="(per video job)">
          <TextInput
            type="number"
            min={1000}
            max={3_600_000}
            step={1000}
            value={videoTimeoutMs}
            onChange={(e) => setVideoTimeoutMs(e.target.value)}
          />
        </Field>
        <Field label="Max attempts" hint="(retryable failures)">
          <TextInput
            type="number"
            min={1}
            max={10}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value)}
          />
        </Field>
        <Field label="Backoff (ms)" hint="(between attempts)">
          <TextInput
            type="number"
            min={0}
            max={600_000}
            step={100}
            value={backoffMs}
            onChange={(e) => setBackoffMs(e.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary">
          Save limits
        </Button>
      </div>
    </Card>
  );
}

/** Parse a numeric field, clamping to [min,max] and falling back when invalid. */
function clampInt(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Image Generation → **Providers**: manage the API keys of every media
 * provider — including image-only vendors (fal, BFL, …) hidden from the LLM
 * Model Providers pane. Keys are stored server-side (auth.json, 0600) and never
 * echoed back; each saved key is listed as `Provider — account` with a
 * copy-to-clipboard and a delete action.
 */
function ImageProvidersCard({
  client,
  list,
  config,
  kind = "image",
  mutate,
  onNotice,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  /** The config this card manages (imageGen or videoGen). */
  config?: MediaGenConfig;
  /** Which media registry the card manages. */
  kind?: "image" | "video";
  mutate: (fn: () => Promise<void>, okMessage: string) => Promise<void>;
  onNotice: (message: string, kind?: "success" | "error") => void;
}) {
  const [providers, setProviders] = useState<Array<MediaProviderInfo | VideoProviderInfo>>([]);
  const [provider, setProvider] = useState(config?.provider ?? "");
  const [keyAccount, setKeyAccount] = useState(config?.account ?? "default");
  const [keyValue, setKeyValue] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  // Copy-to-clipboard feedback + the destructive-delete confirmation.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    providerId: string;
    providerLabel: string;
    accountId: string;
  } | null>(null);
  /** Provider-file editor: undefined existing → create. */
  const [fileModal, setFileModal] = useState<{ existing?: ProviderFileInfo } | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setProviders(kind === "video" ? await client.videoProviders() : await client.imageProviders());
    } catch {
      setProviders([]);
    }
  }, [client, kind]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Seed from config once it lands (config loads async), never clobbering input.
  useEffect(() => {
    if (config === undefined) return;
    setProvider((current) =>
      current.length > 0 ? current : (config.provider ?? ""),
    );
    setKeyAccount((current) =>
      current !== "default" ? current : (config.account ?? "default"),
    );
  }, [config]);

  const providerOptions = (() => {
    const byId = new Map<string, string>();
    for (const p of list.providers) byId.set(p.id, p.name);
    for (const p of providers) byId.set(p.id, p.label);
    return [...byId.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, label]) => ({ value, label }));
  })();

  const selected = providers.find((p) => p.id === provider.trim());
  const storedAccounts = (selected?.accounts ?? []).filter(
    (a) => a.source !== "env",
  );
  const usingEnv = (selected?.accounts ?? []).some((a) => a.source === "env");
  // Every saved image-provider key, across providers (the overview list).
  const savedKeys = providers.flatMap((p) =>
    (p.accounts ?? [])
      .filter((a) => a.source !== "env")
      .map((a) => ({ provider: p, account: a })),
  );

  /** Save the selected provider's key and make it the default image account. */
  const saveKey = (): void => {
    const providerId = provider.trim();
    const accountId = keyAccount.trim() || "default";
    const key = keyValue.trim();
    if (providerId.length === 0 || key.length === 0) return;
    setSavingKey(true);
    void mutate(async () => {
      await client.putAccount(providerId, accountId, {
        label: providerId,
        key,
      });
      // Point the media defaults at the key's account so generations use it.
      await client.putConfig(
        kind === "video"
          ? { videoGen: { provider: providerId, account: accountId } }
          : { imageGen: { provider: providerId, account: accountId } },
      );
    }, `API key saved for ${providerId}`).finally(() => {
      setSavingKey(false);
      setKeyValue("");
      void reload();
    });
  };

  /** Delete a saved key (works for any image provider). */
  const removeKey = (providerId: string, accountId: string): void => {
    void mutate(
      () => client.deleteAccount(providerId, accountId),
      `API key removed for ${providerId}`,
    ).finally(() => {
      void reload();
    });
  };

  /** Fetch a stored key and copy it to the clipboard (never kept client-side). */
  const copyKey = (providerId: string, accountId: string): void => {
    const token = `${providerId}/${accountId}`;
    void mutate(async () => {
      const key = await client.revealAccountKey(providerId, accountId);
      await navigator.clipboard.writeText(key);
      setCopiedKey(token);
      setTimeout(
        () => setCopiedKey((current) => (current === token ? null : current)),
        1500,
      );
    }, `API key copied for ${providerId}`);
  };

  return (
    <Card>
      <SectionHeader
        title="Providers"
        lede={`API keys for ${kind} generation. Stored server-side (auth.json, 0600) and never echoed back; the provider's env var is the fallback.`}
      />
      <div className="form-grid">
        <Field label="Provider">
          <Combobox
            creatable
            value={provider}
            onChange={setProvider}
            options={providerOptions}
            placeholder={kind === "video" ? "fal, runway, kling…" : "fal, openai…"}
            ariaLabel={`${kind} provider`}
            emptyText="Type a provider id."
          />
        </Field>
        <Field label="Account id" hint="(the key's name)">
          <TextInput
            value={keyAccount}
            placeholder="default"
            onChange={(e) => setKeyAccount(e.target.value)}
          />
        </Field>
        <Field
          label={
            provider.trim().length > 0
              ? `${provider.trim()} API key`
              : "API key"
          }
        >
          <TextInput
            type="password"
            value={keyValue}
            placeholder="paste the key"
            onChange={(e) => setKeyValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveKey();
              }
            }}
          />
        </Field>
      </div>
      <p className="dim">
        {selected === undefined
          ? "Pick a provider to add its key."
          : selected.connected === true
            ? `Connected${usingEnv ? " (env var)" : ""} — ${storedAccounts.length} saved key${storedAccounts.length === 1 ? "" : "s"}.`
            : "No saved key yet — generations use the provider's env var if one is set."}
      </p>
      <div>
        <Button
          type="button"
          variant="primary"
          disabled={
            provider.trim().length === 0 ||
            keyValue.trim().length === 0 ||
            savingKey
          }
          onClick={saveKey}
        >
          Save API key
        </Button>{" "}
        <Button
          type="button"
          variant="outline"
          onClick={() => setFileModal({})}
        >
          + Add custom provider
        </Button>
      </div>
      {savedKeys.length > 0 && (
        <ul className="accounts">
          {savedKeys.map(({ provider: p, account: a }) => {
            const token = `${p.id}/${a.id}`;
            const justCopied = copiedKey === token;
            return (
              <li key={token}>
                <span>
                  {p.label} — <i>{a.id}</i>
                </span>
                <span className="key-actions">
                  {p.source === "file" && (
                    <IconButton
                      label={`Edit ${p.label}`}
                      hint="Edit provider file"
                      onClick={() =>
                        setFileModal({
                          existing: {
                            id: p.id,
                            name: p.label,
                            providerType: p.providerType ?? [kind],
                            path: p.path ?? "",
                          },
                        })
                      }
                    >
                      <Pencil size={14} />
                    </IconButton>
                  )}
                  <IconButton
                    label={
                      justCopied
                        ? "Copied"
                        : `Copy ${p.label} API key (${a.id})`
                    }
                    hint={justCopied ? "Copied" : "Copy API key"}
                    onClick={() => copyKey(p.id, a.id)}
                  >
                    {justCopied ? <Check size={14} /> : <Copy size={14} />}
                  </IconButton>
                  <IconButton
                    label={`Delete ${p.label} key ${a.id}`}
                    hint="Delete API key"
                    className="danger"
                    onClick={() =>
                      setPendingDelete({
                        providerId: p.id,
                        providerLabel: p.label,
                        accountId: a.id,
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete API key?"
        body={
          <>
            Delete the key <strong>{pendingDelete?.accountId}</strong> for{" "}
            <strong>{pendingDelete?.providerLabel}</strong>? This cannot be
            undone.
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const pending = pendingDelete;
          setPendingDelete(null);
          if (pending !== null)
            removeKey(pending.providerId, pending.accountId);
        }}
      />
      {fileModal !== null && (
        <ProviderFileModal
          client={client}
          {...(fileModal.existing !== undefined ? { existing: fileModal.existing } : {})}
          onClose={() => setFileModal(null)}
          onSaved={() => void reload()}
          onNotice={onNotice}
        />
      )}
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
  const [modelOptions, setModelOptions] = useState<
    { value: string; label: string; hint?: string }[]
  >([]);
  const [mediaProviders, setMediaProviders] = useState<
    Array<MediaProviderInfo | VideoProviderInfo>
  >([]);

  const providerIds = list.providers
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));
  const knownProvider = list.providers.find((p) => p.id === provider.trim());
  const mediaProvider = mediaProviders.find((p) => p.id === provider.trim());
  const accountIds = (
    mediaProvider?.accounts ??
    knownProvider?.accounts ??
    []
  ).map((a) => a.id);

  const reloadMediaProviders = useCallback(async (): Promise<void> => {
    try {
      setMediaProviders(
        kind === "videoGen"
          ? await client.videoProviders()
          : await client.imageProviders(),
      );
    } catch {
      setMediaProviders([]);
    }
  }, [client, kind]);

  // Reload when the config changes too, so accounts added in the Providers card
  // (above) show up in the Account picker without a remount.
  useEffect(() => {
    void reloadMediaProviders();
  }, [reloadMediaProviders, config]);

  const providerOptions = (() => {
    const byId = new Map<string, string>();
    for (const id of providerIds) byId.set(id, id);
    for (const p of mediaProviders) byId.set(p.id, p.label);
    return [...byId.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([value, label]) => ({ value, label }));
  })();

  // Model autocomplete: the adapter's curated list — the same rows the Image /
  // Video page shows, so the configured default is a real model (the field
  // stays creatable for ids the curated list omits).
  useEffect(() => {
    const providerId = provider.trim();
    if (providerId.length === 0) {
      setModelOptions([]);
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      if (kind === "videoGen") {
        const res = await client.videoCapabilities(
          providerId,
          model.trim() || undefined,
        );
        if (cancelled) return;
        setModelOptions(
          res.models.map((m) => ({
            value: m.id,
            label: m.id,
            hint: videoModelOptionHint(m),
          })),
        );
        setModel((current) =>
          current.trim().length > 0 ? current : res.model,
        );
      } else {
        const res = await client.imageCapabilities(
          providerId,
          model.trim() || undefined,
        );
        if (cancelled) return;
        setModelOptions(
          res.models.map((m) => ({
            value: m.id,
            label: m.id,
            hint: modelOptionHint(m),
          })),
        );
        setModel((current) =>
          current.trim().length > 0 ? current : res.model,
        );
      }
    };
    void load().catch(() => {
      if (!cancelled) setModelOptions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [client, kind, provider, model]);

  const modelPlaceholder =
    kind === "videoGen"
      ? modelOptions[0]?.value ?? "veo-3.1…"
      : modelOptions[0]?.value ?? "gpt-image-2…";

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
    void mutate(async () => {
      if (kind === "imageGen") await client.putConfig({ imageGen: value });
      else await client.putConfig({ videoGen: value });
    }, `${title} default set to ${modelId} via ${providerId}`);
  };

  return (
    <Card as="form" onSubmit={submit}>
      <SectionHeader
        title={title}
        lede={
          <>
            Defaults for the {kind === "imageGen" ? "image" : "video"} workbench
            — jobs without an explicit model use this.{" "}
            {kind === "imageGen"
              ? "Keys are managed in Providers above."
              : "Accounts come from the provider's saved keys."}{" "}
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
            options={providerOptions}
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
        <Field
          label="Model"
          hint={
            mediaProvider !== undefined && provider.trim().length > 0
              ? mediaProvider.label
              : undefined
          }
        >
          <Combobox
            creatable
            value={model}
            onChange={setModel}
            options={modelOptions}
            placeholder={modelPlaceholder}
            ariaLabel={`${title} model`}
            emptyText="Type a model id."
          />
        </Field>
      </div>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={provider.trim().length === 0 || model.trim().length === 0}
        >
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
function WebSearchPane({
  client,
  onNotice,
}: {
  client: BaiClient;
  onNotice: OnNotice;
}) {
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

  const save = async (patch: {
    provider?: WebSearchProviderId;
    keylessFallback?: boolean;
  }): Promise<void> => {
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

  const available = status.available
    .map((name) => WEB_SEARCH_PROVIDER_LABELS[name] ?? name)
    .join(", ");
  const keyLine = (label: string, detected: boolean): string =>
    `${label}: ${detected ? "key detected" : "no key"}`;

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
            onChange={(value) =>
              void save({ provider: value as WebSearchProviderId })
            }
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
          {keyLine("Exa", status.keys.exa)} ·{" "}
          {keyLine("Parallel", status.keys.parallel)}
        </p>
        <p className="dim">
          Available now: {available.length > 0 ? available : "none"}
        </p>
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
 * bai AS an MCP server (config mcpServer.enabled) — the reverse of the
 * integrations list: external clients connect here and call bai's tools,
 * skills, and session operations over `/mcp` (streamable HTTP).
 */
function McpServerRoleCard({
  role,
  onRoleChange,
  onNotice,
}: {
  role: McpServerRoleStatus;
  onRoleChange: (enabled: boolean) => Promise<void>;
  onNotice: OnNotice;
}) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const origin =
    typeof window !== "undefined" && window.location.origin.length > 0
      ? window.location.origin
      : "http://127.0.0.1:9640";
  const endpoint = `${origin}/mcp`;
  const stdioConfig = JSON.stringify(
    { mcpServers: { bai: { command: "bai", args: ["mcp"] } } },
    null,
    2,
  );
  const httpConfig = JSON.stringify(
    { mcpServers: { bai: { url: endpoint } } },
    null,
    2,
  );

  const copy = (label: string, text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500);
      })
      .catch(() => onNotice("Could not copy to the clipboard", "error"));
  };

  const toggle = (enabled: boolean): void => {
    setSaving(true);
    void onRoleChange(enabled)
      .then(() => onNotice(enabled ? "Run as MCP server: on" : "Run as MCP server: off"))
      .catch((err: unknown) => onNotice(err instanceof Error ? err.message : String(err), "error"))
      .finally(() => setSaving(false));
  };

  return (
    <Card>
      <SectionHeader
        title="bai as MCP server"
        lede="Expose bai's tools, skills, and sessions over the Model Context Protocol. External agents call bai's tools in a shared, auto-approved session, read skills as prompts/resources, and can create and drive sessions."
      />
      <ToggleRow
        checked={role.enabled}
        onChange={(on) => {
          if (!saving) toggle(on);
        }}
        title="Run as MCP server"
        description={
          `${role.transport} at ${endpoint} · ${role.tools} tools · ${role.skills} skills · ` +
          `${role.sessions} sessions. Applies live; bai --mcp always enables it.`
        }
      />
      <h4 className="settings-subheading">Connect a client</h4>
      <p className="section-lede">
        Desktop clients (Claude Desktop, Cursor) spawn the stdio bridge; HTTP
        clients can point straight at the endpoint. Loopback needs no token; on
        a <code>--host</code> server send{" "}
        <code>Authorization: Bearer &lt;token&gt;</code>.
      </p>
      <div className="provider-actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => copy("stdio", stdioConfig)}
        >
          {copied === "stdio" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{" "}
          Copy stdio config
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => copy("http", httpConfig)}
        >
          {copied === "http" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{" "}
          Copy HTTP config
        </Button>
      </div>
      <pre className="mcp-connect-snippet">{httpConfig}</pre>
    </Card>
  );
}

/**
 * Integrations section: installed MCP servers (status, enable/disable,
 * authorize, retry, remove) plus the curated catalog. Installing a catalog
 * entry writes a drop-in file under ~/.config/bai/mcp/ and starts OAuth.
 */
function IntegrationsPane({
  client,
  onNotice,
}: {
  client: BaiClient;
  onNotice: OnNotice;
}) {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [role, setRole] = useState<McpServerRoleStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [authName, setAuthName] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [serverModal, setServerModal] = useState<
    | { mode: "add" }
    | {
        mode: "edit";
        server: {
          name: string;
          source: McpServerSource;
          config: MCPServerConfig;
        };
      }
    | null
  >(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const [nextServers, nextCatalog, nextRole] = await Promise.all([
        client.getMcpServers(),
        client.getMcpCatalog(),
        client.mcpServerRole(),
      ]);
      setServers(nextServers);
      setCatalog(nextCatalog);
      setRole(nextRole);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  /** Persist the server-role toggle and refresh its status (applies live). */
  const setRoleEnabled = async (enabled: boolean): Promise<void> => {
    await client.putConfig({ mcpServer: { enabled } });
    setRole(await client.mcpServerRole());
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

  const run = async (
    key: string,
    fn: () => Promise<void>,
    ok: string,
  ): Promise<void> => {
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
    onNotice(
      "Authorize in the browser window — this page updates automatically when it completes.",
    );
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
    await run(
      name,
      () => client.finishMcpAuth(name, authCode.trim()),
      `${name} authorized`,
    );
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

  // Search + category grouping for a catalog that is now dozens of entries.
  const query = catalogQuery.trim().toLowerCase();
  const filteredCatalog =
    query.length === 0
      ? catalog
      : catalog.filter((entry) =>
          `${entry.title} ${entry.name} ${entry.description} ${entry.category}`
            .toLowerCase()
            .includes(query),
        );
  const catalogGroups: { category: string; entries: McpCatalogEntry[] }[] = [];
  for (const entry of filteredCatalog) {
    let group = catalogGroups.find((g) => g.category === entry.category);
    if (group === undefined) {
      group = { category: entry.category, entries: [] };
      catalogGroups.push(group);
    }
    group.entries.push(entry);
  }

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
            <TextInput
              value={authCode}
              placeholder="paste code…"
              onChange={(e) => setAuthCode(e.target.value)}
            />
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

      {/* --- bai as an MCP server (the reverse direction of the list below) --- */}
      {role !== null && (
        <McpServerRoleCard
          role={role}
          onRoleChange={setRoleEnabled}
          onNotice={onNotice}
        />
      )}

      {/* --- Catalog (first, height-capped so it never buries the servers) --- */}
      <h3 className="settings-subheading">Catalog</h3>
      <p className="section-lede">
        Official vendor-hosted MCP servers, grouped by category. Install writes
        a drop-in file in ~/.config/bai/mcp/, then starts OAuth where required.
      </p>
      <div className="provider-actions">
        <TextInput
          value={catalogQuery}
          placeholder={`Search ${catalog.length} integrations…`}
          onChange={(e) => setCatalogQuery(e.target.value)}
          style={{ flex: 1, maxWidth: 420 }}
        />
      </div>
      {catalogGroups.length === 0 ? (
        <p className="dim provider-empty">
          No integrations match "{catalogQuery.trim()}".
        </p>
      ) : (
        <div className="provider-accordion mcp-catalog-scroll">
          {catalogGroups.map((group) => (
            <div key={group.category}>
              <p className="mcp-category">
                <CategoryIcon category={group.category} />
                {group.category}
              </p>
              {group.entries.map((entry) => (
                <ListItem
                  key={entry.name}
                  icon={<BrandIcon name={entry.name} />}
                  title={
                    <>
                      <strong>{entry.title}</strong>{" "}
                      <span className="mcp-badge">
                        {entry.oauth === true ? "OAuth" : "No auth"}
                      </span>
                    </>
                  }
                  subtitle={
                    <>
                      <span className="mcp-row-meta">{entry.description}</span>
                      {entry.envVars !== undefined &&
                        entry.envVars.length > 0 && (
                          <span className="mcp-row-meta">
                            {" "}
                            env: {entry.envVars.map((v) => v.name).join(", ")}
                          </span>
                        )}
                    </>
                  }
                  trailing={
                    <Button
                      type="button"
                      variant={installed.has(entry.name) ? "ghost" : "primary"}
                      disabled={busy !== null || installed.has(entry.name)}
                      onClick={() => void install(entry.name)}
                    >
                      {installed.has(entry.name) ? "Installed" : "Install"}
                    </Button>
                  }
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* --- Custom MCP servers (files in ~/.config/bai/mcp/ or config.json) --- */}
      <h3 className="settings-subheading">Custom MCP Servers</h3>
      <p className="section-lede">
        Your own servers — files in ~/.config/bai/mcp/ or config.json. Their
        tools appear as <code>mcp/&lt;server&gt;/&lt;tool&gt;</code>.
      </p>
      <div className="provider-actions">
        <Button
          variant="outline"
          onClick={() => setServerModal({ mode: "add" })}
        >
          + Add a custom MCP server
        </Button>
      </div>
      {servers.length === 0 ? (
        <p className="dim provider-empty">
          No MCP servers yet. Install one above, or drop a file into
          ~/.config/bai/mcp/.
        </p>
      ) : (
        <div className="provider-accordion">
          {servers.map((server) => (
            <div key={server.name} className="mcp-row">
              <div className="mcp-row-main">
                <BrandIcon name={server.name} />
                <div>
                  <span className="mcp-row-title">
                    <strong>{server.name}</strong>
                  </span>
                  <div className="mcp-row-meta">
                    {MCP_STATE_LABELS[server.state]} · {server.transport} ·{" "}
                    {server.tools} tool
                    {server.tools === 1 ? "" : "s"} ·{" "}
                    {server.source === "file" ? "file" : "config.json"}
                    {server.error !== undefined ? ` · ${server.error}` : ""}
                  </div>
                </div>
              </div>
              <div className="mcp-row-actions">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void openEdit(server.name)}
                >
                  Edit
                </Button>
                {server.state === "needs_auth" && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void authorize(server.name)}
                  >
                    Authorize
                  </Button>
                )}
                {server.state === "failed" && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        server.name,
                        () => client.reconnectMcpServer(server.name),
                        "Reconnect requested",
                      )
                    }
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
                      () =>
                        client.setMcpServerEnabled(
                          server.name,
                          server.state === "disabled",
                        ),
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
                    onClick={() => setPendingRemove(server.name)}
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
          {...(serverModal.mode === "edit"
            ? { server: serverModal.server }
            : {})}
          onClose={() => setServerModal(null)}
          onSaved={() => void load()}
          onNotice={onNotice}
        />
      )}
      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove MCP server?"
        body={
          <>
            Remove <strong>{pendingRemove}</strong> and its drop-in file? This
            cannot be undone.
          </>
        }
        confirmLabel="Remove"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const name = pendingRemove;
          setPendingRemove(null);
          if (name !== null)
            void run(
              name,
              () => client.deleteMcpServer(name),
              `Removed ${name}`,
            );
        }}
      />
    </>
  );
}
