import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ModelInfo, ProviderListResponse, Session } from "@bai/shared";
import { isZdrCapableModel, sortModelsZdrFirst } from "@bai/shared";
import { sortProviders } from "./provider-utils";
import { IconButton, useDialogFocus } from "./ui";

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
      >
        <span className="dim">model</span>
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(true, dialogRef);

  // Engagement refetch on open (TUI ctrl+p parity): every open pulls fresh
  // data; the firehose keeps it live between opens.
  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  // esc closes (backdrop click and the × button are wired in the JSX).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Connected providers only (the composer hub picks a model to USE; account
  // setup lives in Settings → Model Providers). Connected first, stub last —
  // the shared sort stance.
  const providers =
    list === null ? [] : sortProviders(list.providers.filter((p) => p.connected));

  // Default selection: the provider backing the current model, else the
  // first connected one that actually offers models.
  const currentProviderId = current.split("/")[0];
  const effectiveProviderId =
    providerId ??
    (providers.some((p) => p.id === currentProviderId)
      ? currentProviderId
      : (providers.find((p) => p.models.length > 0)?.id ?? providers[0]?.id ?? null));
  const provider = providers.find((p) => p.id === effectiveProviderId);

  // Scroll the active provider row into view — the default selection (the
  // current model's provider) can sit far down a 200-entry catalog list.
  // block:"nearest" makes this a no-op when the row is already visible
  // (e.g. right after a click).
  useEffect(() => {
    document
      .querySelector(".model-col-list .model-row.active")
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

  // Label-sorted; with preferZdr the ZDR-capable models float first.
  const models: ModelInfo[] =
    provider === undefined
      ? []
      : sortModelsZdrFirst(
          [...provider.models].sort((a, b) => a.label.localeCompare(b.label)),
          preferZdr === true,
        );

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="model-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pick a model"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="model-modal-head">
          <strong>Pick a model</strong>
          <IconButton className="modal-close" label="Close model picker" hint="Close model picker" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
        {list === null ? (
          <p className="dim modal-loading">Loading providers…</p>
        ) : (
          <div className="model-columns">
            <div className="model-col">
              <div className="model-col-head">provider</div>
              <div className="model-col-list">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={p.id === effectiveProviderId ? "model-row active" : "model-row"}
                    onClick={() => {
                      setProviderId(p.id);
                      setAccountId(null); // account choices are per-provider
                    }}
                  >
                    <span className="title">{p.name}</span>
                    <span className="dim">{p.adapter}</span>
                    {p.connected && (
                      <span className="check" title="connected">
                        <Check size={12} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="model-col">
              <div className="model-col-head">account</div>
              <div className="model-col-list">
                <button
                  type="button"
                  className={effectiveAccountId === null ? "model-row active" : "model-row"}
                  onClick={() => setAccountId(null)}
                >
                  <span className="title">Server default</span>
                  <span className="dim">auto-resolve</span>
                </button>
                {provider?.accounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={effectiveAccountId === a.id ? "model-row active" : "model-row"}
                    onClick={() => setAccountId(a.id)}
                  >
                    <span className="title">{a.label}</span>
                    <span className="dim">{a.source === "env" ? "from environment" : "api key"}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="model-col">
              <div className="model-col-head">model</div>
              <div className="model-col-list">
                {models.length === 0 && <p className="dim col-hint">No models.</p>}
                {models.map((m) => {
                  const isCurrent = provider !== undefined && provider.id === currentProviderId && m.id === current;
                  const parts: string[] = [];
                  if (m.contextWindow !== undefined) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
                  if (m.inputCost !== undefined) parts.push(`$${m.inputCost}/M in`);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className="model-row"
                      disabled={busy}
                      onClick={() => void apply(m.id)}
                    >
                      <span className="title">{m.label}</span>
                      {parts.length > 0 && <span className="dim">{parts.join(" · ")}</span>}
                      {preferZdr === true && isZdrCapableModel(m.id, m.provider) && (
                        <span className="zdr-badge" title="zero data retention capable">
                          zdr
                        </span>
                      )}
                      {isCurrent && <span className="current-badge">current</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {error !== null && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
