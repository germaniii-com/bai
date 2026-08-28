import type { BaiClient } from "@bai/api/client";
import type { ProviderListResponse, Session } from "@bai/shared";

/**
 * Chat-header model picker. Session-scoped when a session is open (the next
 * prompt uses it), otherwise sets the global default. The account is left to
 * the server's default-account resolution unless the session already pinned
 * one.
 */
export function ModelPicker({
  client,
  list,
  active,
  refreshProviders,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  active: Session | null;
  refreshProviders: () => Promise<void>;
}) {
  const meta = active?.meta as { model?: unknown; account?: unknown } | undefined;
  const current =
    typeof meta?.model === "string" ? meta.model : (list.default.model ?? "stub/echo");
  const connected = list.providers.filter((p) => p.connected && p.models.length > 0);

  const change = (value: string): void => {
    if (value.length === 0 || value === current) return;
    if (active !== null) {
      void client.setSessionModel(active.id, { model: value }).then(() => refreshProviders());
    } else {
      void client.putConfig({ models: { default: value } }).then(() => refreshProviders());
    }
  };

  return (
    <label className="model-picker">
      <span className="dim">model</span>
      <select value={connected.some((p) => p.models.some((m) => m.id === current)) ? current : ""} onChange={(e) => change(e.target.value)}>
        <option value="" disabled>
          {current}
        </option>
        {connected.map((p) => (
          <optgroup key={p.id} label={p.name}>
            {p.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {typeof meta?.account === "string" && p.id === current.split("/")[0] ? ` · ${String(meta.account)}` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
