import type { AccountInfo, ModelInfo, ProviderInfo, ProviderListResponse, Session } from "@bai/shared";
import { isZdrCapableModel, modelCapabilities, sortModelsZdrFirst } from "@bai/shared";

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
  /** Right-side warning badge (e.g. "△ 1" — a session's pending asks). */
  badge?: string;
  /** Inline capability tags after the label, e.g. "(think) (vision)". */
  caps?: string;
}

/** "(think) (vision)" inline tags for a model's catalog capabilities. */
function capabilityTags(model: ModelInfo): string | undefined {
  const caps = modelCapabilities(model);
  return caps.length > 0 ? caps.map((c) => `(${c.label})`).join(" ") : undefined;
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

/**
 * Models of one provider, label-sorted, with context/cost hints. With
 * `preferZdr` the ZDR-capable models float first (config models.preferZdr)
 * and carry a "zdr" hint badge.
 */
export function modelOptions(provider: ProviderInfo, preferZdr = false): PickerOption[] {
  const models: ModelInfo[] = sortModelsZdrFirst(
    [...provider.models].sort((a, b) => a.label.localeCompare(b.label)),
    preferZdr,
  );
  const out: PickerOption[] = models.map((m) => {
    const parts: string[] = [];
    if (preferZdr && isZdrCapableModel(m.id, m.provider)) parts.push("zdr");
    if (m.contextWindow !== undefined) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
    if (m.inputCost !== undefined) parts.push(`$${m.inputCost}/M in`);
    const caps = capabilityTags(m);
    return {
      value: m.id,
      label: m.label,
      ...(caps !== undefined ? { caps } : {}),
      ...(parts.length > 0 ? { hint: parts.join(" · ") } : {}),
    };
  });
  // The catalog is a convenience, not a gate (ARCHITECTURE §10): any model id
  // is accepted at call time.
  out.push({ value: "__custom__", label: "Type a model id…", hint: "any id accepted" });
  return out;
}

/**
 * Flat model list across all connected providers (the supermenu's Switch
 * model command / hub model chip — no
 * provider step). Values are full "provider/model" ids; the server resolves
 * the provider's default account when none is sent. The echo stub is not a
 * real model to switch to and is excluded (same stance as `needsSetup`).
 * With `preferZdr` the ZDR-capable models float to the top of the FLAT list
 * (provider-alpha + label order preserved within the two groups); the
 * "zdr" hint badge marks them, and the custom escape hatch stays last.
 */
export function allModelOptions(providers: ProviderInfo[], preferZdr = false): PickerOption[] {
  const connected = providers
    .filter((p) => p.connected && p.id !== "stub" && p.models.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const tagged: { id: string; provider: string; opt: PickerOption }[] = [];
  for (const p of connected) {
    for (const m of [...p.models].sort((a, b) => a.label.localeCompare(b.label))) {
      const parts: string[] = [p.name];
      if (preferZdr && isZdrCapableModel(m.id, m.provider)) parts.push("zdr");
      if (m.contextWindow !== undefined) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
      if (m.inputCost !== undefined) parts.push(`$${m.inputCost}/M in`);
      const caps = capabilityTags(m);
      tagged.push({
        id: m.id,
        provider: m.provider,
        opt: {
          value: m.id,
          label: m.label,
          ...(caps !== undefined ? { caps } : {}),
          hint: parts.join(" · "),
        },
      });
    }
  }
  const out = sortModelsZdrFirst(tagged, preferZdr).map((t) => t.opt);
  out.push({ value: "__custom__", label: "Type a model id…", hint: "provider/model" });
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
  configDefault?: string,
): string {
  const meta = active?.meta as { model?: unknown; account?: unknown } | undefined;
  // Mirrors the run path's fallback (service.ts defaultModel → "stub/echo").
  // `configDefault` (GET /api/config) keeps the header truthful without the
  // full provider list, which is fetched on demand (the pickers) only.
  const model =
    typeof meta?.model === "string"
      ? meta.model
      : (list?.default.model ?? configDefault ?? "stub/echo");
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
