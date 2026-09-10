import { useEffect, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ModelInfo, ProviderListResponse, Session } from "@bai/shared";
import { isZdrCapableModel, sortModelsZdrFirst } from "@bai/shared";
import { sortProviders } from "./provider-utils";
import { ListItem, Modal } from "./components";

/**
 * Chat-header model picker: a button showing the current model; clicking it
 * opens a three-column modal — provider → accounts → models. Lists CONNECTED
 * providers only: the composer hub picks a model to USE, while adding
 * accounts happens under Settings → Model Providers (which shows the full
 * catalog). Same stance as the TUI's ctrl+l flat list. Clicking a model
 * applies it and closes: session-scoped when a session is open, otherwise
 * the global default. With `preferZdr` (config models.preferZdr) the
 * ZDR-capable models float first and carry a badge.
 *
 * Account semantics mirror the TUI: "Server default" (no explicit account)
 * lets the server resolve the provider's default (config override → first
 * stored → env); picking an account pins it — `account` on the session
 * model, `defaultAccount` on the global config.
 */
export function ModelPicker({
  client,
  list,
  active,
  configDefault,
  preferZdr,
  refreshProviders,
}: {
  client: BaiClient;
  /** Null until the first engagement fetch lands — the modal loads it. */
  list: ProviderListResponse | null;
  active: Session | null;
  /** Default model from GET /api/config (startup fetch) — keeps the button
   * label truthful before the heavy provider list is ever loaded. */
  configDefault?: string;
  /** config models.preferZdr — ZDR-capable models sort first with a badge. */
  preferZdr?: boolean;
  refreshProviders: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  const meta = active?.meta as { model?: unknown; account?: unknown } | undefined;
  // Session-pinned model → provider-list default (freshest) → config
  // default (startup fetch) → stub fallback.
  const current =
    typeof meta?.model === "string"
      ? meta.model
      : (list?.default.model ?? configDefault ?? "stub/echo");
  const accountSuffix = accountLabel(list, current, meta) ?? "";

  return (
    <>
      <button
        type="button"
        className="model-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`model: ${current}${accountSuffix}`}
        data-tooltip={`Model: ${current}${accountSuffix}`}
      >
        <Cpu size={13} aria-hidden="true" />
        <span className="model-current">
          {current}
          {accountSuffix.length > 0 && <span className="dim"> · {accountSuffix}</span>}
        </span>
        <span className="model-caret" aria-hidden="true">
          <ChevronDown size={12} />
        </span>
      </button>
      {open && (
        <ModelModal
          client={client}
          list={list}
          active={active}
          preferZdr={preferZdr}
          refreshProviders={refreshProviders}
          current={current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Label of the account pinned on the active session (when it resolves). */
function accountLabel(
  list: ProviderListResponse | null,
  current: string,
  meta: { model?: unknown; account?: unknown } | undefined,
): string | undefined {
  if (typeof meta?.account !== "string") return undefined;
  const providerId = current.split("/")[0];
  const provider = list?.providers.find((p) => p.id === providerId);
  return provider?.accounts.find((a) => a.id === meta.account)?.label ?? meta.account;
}

/** The three-column picker modal, exported for capture-mode reuse (the Learn form). */
export function ModelModal({
  client,
  list,
  active,
  preferZdr,
  refreshProviders,
  current,
  onClose,
  onPick,
}: {
  client: BaiClient;
  list: ProviderListResponse | null;
  active: Session | null;
  preferZdr?: boolean;
  refreshProviders: () => Promise<void>;
  current: string;
  onClose: () => void;
  /**
   * Capture mode (the Learn form): clicking a model resolves the selection
   * through `onPick` instead of applying it to the session/config. The
   * caller owns what happens with the choice.
   */
  onPick?: (modelId: string, accountId: string | null) => void;
}) {
  const [providerId, setProviderId] = useState<string | null>(null);
  // null = "Server default" (server resolves the provider's default account).
  const [accountId, setAccountId] = useState<string | null>(null);
  // The one search bar (TUI SelectDialog parity): filters MODELS only —
  // case-insensitive substring over the model's label OR id — and the
  // provider column cascades to providers offering at least one match
  // (accounts follow the selected provider). State dies with the modal (it
  // unmounts on close), so the filter never lingers between opens.
  const [modelFilter, setModelFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Engagement refetch on open (TUI ctrl+p parity): every open pulls fresh
  // data; the firehose keeps it live between opens.
  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // Connected providers only (the composer hub picks a model to USE; account
  // setup lives in Settings → Model Providers). Connected first, stub last —
  // the shared sort stance.
  const providers =
    list === null ? [] : sortProviders(list.providers.filter((p) => p.connected));

  // The search (TUI SelectDialog filter semantics): case-insensitive
  // substring over the model's label OR id. Non-empty, the provider column
  // cascades to providers offering at least one matching model.
  const query = modelFilter.trim().toLowerCase();
  const modelMatches = (m: ModelInfo): boolean =>
    m.label.toLowerCase().includes(query) || m.id.toLowerCase().includes(query);
  const visibleProviders = query.length > 0 ? providers.filter((p) => p.models.some(modelMatches)) : providers;

  // Default selection: an explicit pick that is still visible wins; else the
  // provider backing the current model (when visible); else the first
  // visible one that actually offers models. Scoped to the VISIBLE list so
  // a search that hides the picked/current provider falls back to a
  // matching one (the explicit pick returns when the search clears).
  const currentProviderId = current.split("/")[0];
  const effectiveProviderId =
    providerId !== null && visibleProviders.some((p) => p.id === providerId)
      ? providerId
      : visibleProviders.some((p) => p.id === currentProviderId)
        ? currentProviderId
        : (visibleProviders.find((p) => p.models.length > 0)?.id ?? visibleProviders[0]?.id ?? null);
  const provider = providers.find((p) => p.id === effectiveProviderId);

  // Scroll the active provider row into view — the default selection (the
  // current model's provider) can sit far down a 200-entry catalog list.
  // block:"nearest" makes this a no-op when the row is already visible
  // (e.g. right after a click).
  useEffect(() => {
    document
      .querySelector(".model-col-list .list-item.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [effectiveProviderId]);

  // Effective account: explicit pick wins; otherwise the session-pinned
  // account when it belongs to this provider; otherwise server default.
  const meta = active?.meta as { model?: unknown; account?: unknown } | undefined;
  const pinnedAccount = typeof meta?.account === "string" ? meta.account : null;
  const effectiveAccountId =
    accountId ??
    (pinnedAccount !== null && provider?.accounts.some((a) => a.id === pinnedAccount)
      ? pinnedAccount
      : null);

  const apply = async (modelId: string): Promise<void> => {
    // Capture mode: hand the choice to the caller (no session/config write).
    if (onPick !== undefined) {
      onPick(modelId, effectiveAccountId);
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (active !== null) {
        await client.setSessionModel(active.id, {
          model: modelId,
          ...(effectiveAccountId !== null ? { account: effectiveAccountId } : {}),
        });
      } else {
        await client.putConfig({
          models: {
            default: modelId,
            ...(effectiveAccountId !== null && provider !== undefined
              ? { defaultAccount: { [provider.id]: effectiveAccountId } }
              : {}),
          },
        });
      }
      await refreshProviders();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Label-sorted; with preferZdr the ZDR-capable models float first. The
  // search narrows this to the matches (empty query → everything).
  const models: ModelInfo[] =
    provider === undefined
      ? []
      : sortModelsZdrFirst(
          [...provider.models].sort((a, b) => a.label.localeCompare(b.label)),
          preferZdr === true,
        );
  const visibleModels = query.length > 0 ? models.filter(modelMatches) : models;

  return (
    <Modal open onClose={onClose} title="Pick a model" ariaLabel="Pick a model" bodyClassName="unpadded">
      {list === null ? (
        <p className="dim modal-loading">Loading providers…</p>
      ) : (
        <>
          {/* The one search bar (TUI type-to-filter parity): filters
              MODELS only; the provider column cascades to providers
              offering a match, accounts follow the selected provider. */}
          <input
            className="model-search"
            type="search"
            placeholder="Filter models…"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            aria-label="Filter models"
          />
          <div className="model-columns">
            <div className="model-col">
              <div className="model-col-head">provider</div>
              <div className="model-col-list">
                {query.length > 0 && visibleProviders.length === 0 && (
                  <p className="dim col-hint">No matches.</p>
                )}
                {visibleProviders.map((p) => (
                  <ListItem
                    key={p.id}
                    title={p.name}
                    subtitle={p.adapter}
                    selected={p.id === effectiveProviderId}
                    onClick={() => {
                      setProviderId(p.id);
                      setAccountId(null); // account choices are per-provider
                    }}
                    trailing={p.connected ? <Check size={12} aria-hidden="true" /> : undefined}
                  />
                ))}
              </div>
            </div>
            <div className="model-col">
              <div className="model-col-head">account</div>
              <div className="model-col-list">
                <ListItem
                  title="Server default"
                  subtitle="auto-resolve"
                  selected={effectiveAccountId === null}
                  onClick={() => setAccountId(null)}
                />
                {provider?.accounts.map((a) => (
                  <ListItem
                    key={a.id}
                    title={a.label}
                    subtitle={a.source === "env" ? "from environment" : "api key"}
                    selected={effectiveAccountId === a.id}
                    onClick={() => setAccountId(a.id)}
                  />
                ))}
              </div>
            </div>
            <div className="model-col">
              <div className="model-col-head">model</div>
              <div className="model-col-list">
                {query.length > 0 && visibleProviders.length === 0 ? (
                  // No provider offers a match — the cascade emptied both
                  // columns; one message covers them.
                  <p className="dim col-hint">No matches.</p>
                ) : (
                  <>
                    {models.length === 0 && <p className="dim col-hint">No models.</p>}
                    {models.length > 0 && visibleModels.length === 0 && (
                      <p className="dim col-hint">No matches.</p>
                    )}
                  </>
                )}
                {visibleModels.map((m) => {
                  const isCurrent = provider !== undefined && provider.id === currentProviderId && m.id === current;
                  const parts: string[] = [];
                  if (m.contextWindow !== undefined) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
                  if (m.inputCost !== undefined) parts.push(`$${m.inputCost}/M in`);
                  return (
                    <ListItem
                      key={m.id}
                      title={m.label}
                      subtitle={parts.length > 0 ? parts.join(" · ") : undefined}
                      disabled={busy}
                      onClick={() => void apply(m.id)}
                      trailing={
                        <>
                          {preferZdr === true && isZdrCapableModel(m.id, m.provider) && (
                            <span className="li-badge success" title="zero data retention capable">
                              zdr
                            </span>
                          )}
                          {isCurrent && <span className="li-badge accent">current</span>}
                        </>
                      }
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
      {error !== null && <div className="error" role="alert">{error}</div>}
    </Modal>
  );
}
