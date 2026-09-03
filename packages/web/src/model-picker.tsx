import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { ModelInfo, ProviderListResponse, Session } from "@bai/shared";

/**
 * Chat-header model picker: a button showing the current model; clicking it
 * opens a three-column modal — provider → accounts → models (the web shape
 * of the TUI's ctrl+p wizard). Clicking a model applies it and closes:
 * session-scoped when a session is open, otherwise the global default.
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
  refreshProviders,
}: {
  client: BaiClient;
  /** Null until the first engagement fetch lands — the modal loads it. */
  list: ProviderListResponse | null;
  active: Session | null;
  /** Default model from GET /api/config (startup fetch) — keeps the button
   * label truthful before the heavy provider list is ever loaded. */
  configDefault?: string;
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
          ▾
        </span>
      </button>
      {open && (
        <ModelModal
          client={client}
          list={list}
          active={active}
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

function ModelModal({
  client,
  list,
  active,
  refreshProviders,
  current,
  onClose,
}: {
  client: BaiClient;
  list: ProviderListResponse | null;
  active: Session | null;
  refreshProviders: () => Promise<void>;
  current: string;
  onClose: () => void;
}) {
  const [providerId, setProviderId] = useState<string | null>(null);
  // null = "Server default" (server resolves the provider's default account).
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  // Connected first (stable), stub last — same stance as the settings nav.
  const providers =
    list === null
      ? []
      : [...list.providers].sort((a, b) => {
          const ac = a.connected ? 0 : 1;
          const bc = b.connected ? 0 : 1;
          if (ac !== bc) return ac - bc;
          if (a.id === "stub") return 1;
          if (b.id === "stub") return -1;
          return a.id.localeCompare(b.id);
        });

  // Default selection: the provider backing the current model, else the
  // first connected one, else the first entry.
  const currentProviderId = current.split("/")[0];
  const effectiveProviderId =
    providerId ??
    (providers.some((p) => p.id === currentProviderId)
      ? currentProviderId
      : (providers.find((p) => p.connected)?.id ?? providers[0]?.id ?? null));
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

  const models: ModelInfo[] =
    provider === undefined ? [] : [...provider.models].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="model-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pick a model"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="model-modal-head">
          <strong>Pick a model</strong>
          <button type="button" className="modal-close" onClick={onClose} aria-label="close">
            ×
          </button>
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
                        ✓
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
                {provider !== undefined && provider.accounts.length === 0 && (
                  <p className="dim col-hint">no accounts — add one under settings</p>
                )}
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
                      {isCurrent && <span className="current-badge">current</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        {error !== null && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
