import { useEffect, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ModelInfo, ProviderInfo, ProviderListResponse, Session } from "@bai/shared";
import { isZdrCapableModel, sortModelsZdrFirst } from "@bai/shared";
import { sortProviders } from "./provider-utils";
import { ModelCapabilityBadges } from "./model-capabilities";
import { ListItem, Modal } from "./components";

/**
 * Chat-header model picker: a button showing the current model; clicking it
 * opens a single scrollable column of every CONNECTED provider's models.
 * Each row carries the model name, its context window + input price, and the
 * provider · account it would run on. The composer hub picks a model to USE,
 * while adding accounts happens under Settings → Model Providers (which
 * shows the full catalog). Clicking a model applies it and closes:
 * session-scoped when a session is open, otherwise the global default. With
 * `preferZdr` (config models.preferZdr) the ZDR-capable models float first
 * and carry a badge.
 *
 * Account semantics: a row shows the account the pick would pin — the
 * session's pinned account when the provider owns it, otherwise "Server
 * default" (the server resolves config override → first stored → env).
 * Changing which account is pinned happens in Settings → Model Providers.
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
  // Resolve the current model's catalog entry so the trigger can show the
  // same capability glyphs as the picker rows (absent while the list loads).
  const currentModel =
    list === null ? undefined : list.providers.flatMap((p) => p.models).find((m) => m.id === current);

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
        {currentModel !== undefined && <ModelCapabilityBadges model={currentModel} />}
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

/** The single-column picker modal, exported for capture-mode reuse (the Learn form). */
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
  // The one search bar (TUI SelectDialog parity): free-form, case-
  // insensitive substring over the model's label/id OR its provider's
  // name/id. Focused on open. State dies with the modal (it unmounts on
  // close), so the filter never lingers.
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
  const providers = list === null ? [] : sortProviders(list.providers.filter((p) => p.connected));
  const providerById = new Map(providers.map((p) => [p.id, p]));

  const query = modelFilter.trim().toLowerCase();
  // Free-form filter: case-insensitive substring over the model's name/id OR
  // its provider's display name/id — one input matches either (TUI
  // type-to-filter semantics, widened to provider names).
  const modelMatches = (m: ModelInfo): boolean => {
    if (m.label.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)) return true;
    const providerName = providerById.get(m.provider)?.name;
    return m.provider.toLowerCase().includes(query) || (providerName?.toLowerCase().includes(query) ?? false);
  };

  // One flat catalog across every connected provider, label-sorted; with
  // preferZdr the ZDR-capable models float first. The search narrows it.
  const models: ModelInfo[] = sortModelsZdrFirst(
    providers.flatMap((p) => p.models).sort((a, b) => a.label.localeCompare(b.label)),
    preferZdr === true,
  );
  const visibleModels = query.length > 0 ? models.filter(modelMatches) : models;

  // Scroll the current model row into view — it can sit far down a large
  // catalog. block:"nearest" makes this a no-op when already visible.
  useEffect(() => {
    document.querySelector(".model-list .list-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [current]);

  // The session's pinned account applies only to a provider that owns it;
  // every other row falls back to the server-resolved default.
  const meta = active?.meta as { model?: unknown; account?: unknown } | undefined;
  const pinnedAccount = typeof meta?.account === "string" ? meta.account : null;
  const accountFor = (provider: ProviderInfo | undefined): string | null =>
    provider !== undefined && pinnedAccount !== null && provider.accounts.some((a) => a.id === pinnedAccount)
      ? pinnedAccount
      : null;
  const accountLabelFor = (provider: ProviderInfo | undefined): string => {
    const id = accountFor(provider);
    if (id === null) return "Server default";
    return provider?.accounts.find((a) => a.id === id)?.label ?? id;
  };

  const apply = async (model: ModelInfo): Promise<void> => {
    const provider = providerById.get(model.provider);
    const account = accountFor(provider);
    // Capture mode: hand the choice to the caller (no session/config write).
    if (onPick !== undefined) {
      onPick(model.id, account);
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (active !== null) {
        await client.setSessionModel(active.id, {
          model: model.id,
          ...(account !== null ? { account } : {}),
        });
      } else {
        await client.putConfig({
          models: {
            default: model.id,
            ...(account !== null && provider !== undefined
              ? { defaultAccount: { [provider.id]: account } }
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

  return (
    <Modal open onClose={onClose} title="Pick a model" ariaLabel="Pick a model" bodyClassName="unpadded">
      {list === null ? (
        <p className="dim modal-loading">Loading providers…</p>
      ) : (
        <>
          {/* The one search bar (TUI type-to-filter parity): free-form text
              matching a model's name/id OR its provider's name/id. Focused
              on open (`data-autofocus` + `autoFocus`). */}
          <input
            className="model-search"
            type="search"
            placeholder="Filter models or providers…"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            aria-label="Filter models or providers"
            data-autofocus
            autoFocus
          />
          <div className="model-list">
            {visibleModels.length === 0 && (
              <p className="dim col-hint">{query.length > 0 ? "No matches." : "No models."}</p>
            )}
            {visibleModels.map((m) => {
              const provider = providerById.get(m.provider);
              const isCurrent = m.id === current;
              const parts: string[] = [];
              if (m.contextWindow !== undefined) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
              if (m.inputCost !== undefined) parts.push(`$${m.inputCost}/1M`);
              return (
                <ListItem
                  key={m.id}
                  className="model-row"
                  title={
                    <span className="model-row-name">
                      <span className="model-row-label">{m.label}</span>
                      <ModelCapabilityBadges model={m} />
                    </span>
                  }
                  selected={isCurrent}
                  ariaCurrent={isCurrent ? "page" : undefined}
                  disabled={busy}
                  onClick={() => void apply(m)}
                  subtitle={
                    <>
                      {parts.length > 0 && <span className="model-row-meta">{parts.join(" · ")}</span>}
                      <span className="model-row-owner">
                        {provider?.name ?? m.provider} · {accountLabelFor(provider)}
                      </span>
                    </>
                  }
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
        </>
      )}
      {error !== null && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
