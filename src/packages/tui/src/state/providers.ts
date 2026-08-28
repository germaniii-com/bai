import type { AccountInfo, ModelInfo, ProviderInfo, ProviderListResponse, Session } from "@bai/shared";

/**
 * Pure logic for the provider/model picker flow — no rendering, so the
 * wizard's decisions are unit-testable without a terminal.
 */

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  /** Left-gutter mark (✓ for connected providers, · for accounts). */
  gutter?: string;
}

/** Provider list: connected first (both stable), stub last. */
export function providerOptions(providers: ProviderInfo[]): PickerOption[] {
  const sorted = [...providers].sort((a, b) => {
    const ac = a.connected ? 0 : 1;
    const bc = b.connected ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (a.id === "stub") return 1;
    if (b.id === "stub") return -1;
    return a.id.localeCompare(b.id);
  });
  return sorted.map((p) => ({
    value: p.id,
    label: p.name,
    hint: p.connected
      ? `${p.accounts.length} account${p.accounts.length === 1 ? "" : "s"} · ${p.adapter}`
      : p.adapter,
    ...(p.connected ? { gutter: "✓" } : {}),
  }));
}

/** Accounts of one provider (already includes the env pseudo-account). */
export function accountOptions(provider: ProviderInfo): PickerOption[] {
  return provider.accounts.map((a: AccountInfo) => ({
    value: a.id,
    label: a.label,
    hint: a.source === "env" ? "from environment" : a.baseUrl ?? "api key",
    gutter: "·",
  }));
}

/** Models of one provider, label-sorted, with context/cost hints. */
export function modelOptions(provider: ProviderInfo): PickerOption[] {
  const models: ModelInfo[] = [...provider.models].sort((a, b) => a.label.localeCompare(b.label));
  const out: PickerOption[] = models.map((m) => {
    const parts: string[] = [];
    if (m.contextWindow !== undefined) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
    if (m.inputCost !== undefined) parts.push(`$${m.inputCost}/M in`);
    return {
      value: m.id,
      label: m.label,
      ...(parts.length > 0 ? { hint: parts.join(" · ") } : {}),
    };
  });
  // The catalog is a convenience, not a gate (ARCHITECTURE §10): any model id
  // is accepted at call time.
  out.push({ value: "__custom__", label: "Type a model id…", hint: "any id accepted" });
  return out;
}

/** Where a model pick applies: the active session, or the global default. */
export function applyTarget(active: Session | null): "session" | "global" {
  return active !== null ? "session" : "global";
}

/** Current model/account display for the header. */
export function currentModelLabel(
  active: Session | null,
  list: ProviderListResponse | null,
): string {
  const meta = active?.meta as { model?: unknown; account?: unknown } | undefined;
  // Mirrors the run path's fallback (service.ts defaultModel → "stub/echo").
  const model =
    typeof meta?.model === "string"
      ? meta.model
      : (list?.default.model ?? "stub/echo");
  const providerId = model.split("/")[0] ?? model;
  const account =
    typeof meta?.account === "string"
      ? meta.account
      : list?.default.account !== undefined && list.default.model === model
        ? list.default.account
        : undefined;
  const provider = list?.providers.find((p) => p.id === providerId);
  const accountLabel =
    account !== undefined ? provider?.accounts.find((a) => a.id === account)?.label ?? account : undefined;
  return accountLabel !== undefined ? `${model} · ${accountLabel}` : model;
}

/** True when no real (non-stub) provider has an account yet. */
export function needsSetup(list: ProviderListResponse | null): boolean {
  if (list === null) return false;
  return !list.providers.some((p) => p.connected && p.id !== "stub");
}
