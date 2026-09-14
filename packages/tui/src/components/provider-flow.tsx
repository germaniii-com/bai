import { Box, Text } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { ModelPageEntry, ProviderInfo, ProviderListResponse, Session } from "@bai/shared";
import { PromptDialog, SelectDialog } from "./dialog";
import { useTheme } from "../theme";
import { accountOptions, modelPageOptions, providerOptions } from "../state/providers";

/**
 * Provider wizard (the opencode /connect pattern, extended for multi-account):
 * provider list → account management (add/remove/select) → model picker →
 * apply to the active session (or the global default when none is open).
 * Each step replaces the last; esc backs out one level. The wizard is the
 * one path that selects provider AND account AND model (no accounts-only
 * shortcut).
 *
 * The Switch model command (supermenu / hub model chip) skips the provider
 * step, opening at the flat `all-models` step via `initialStep`.
 */
type Step =
  | { kind: "providers" }
  | { kind: "accounts"; providerId: string }
  | { kind: "add-id"; providerId: string }
  | { kind: "add-label"; providerId: string; accountId: string }
  | { kind: "add-key"; providerId: string; accountId: string; label: string }
  | { kind: "add-url"; providerId: string; accountId: string; label: string; key: string }
  | { kind: "models"; providerId: string; accountId?: string }
  | { kind: "all-models" }
  | { kind: "custom-model"; providerId?: string; accountId?: string };

export function ProviderFlow({
  client,
  list,
  active,
  preferZdr,
  initialStep,
  onDone,
  onRefresh,
  windowSize,
}: {
  client: BaiClient;
  list: ProviderListResponse;
  active: Session | null;
  /** config models.preferZdr — ZDR-capable models sort first in the pickers. */
  preferZdr?: boolean;
  /** Entry step for the shortcut bindings (default: the provider list). */
  initialStep?: Step;
  onDone: () => void;
  /** Refetch providers after account mutations (app owns the state). */
  onRefresh: () => void;
  /** Sliding-window size for the picker steps (overlay height cap). */
  windowSize?: number;
}) {
  const [step, setStep] = useState<Step>(initialStep ?? { kind: "providers" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const findProvider = (id: string): ProviderInfo | undefined => list.providers.find((p) => p.id === id);

  const guard = (fn: () => Promise<void>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    fn()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const applyModel = (
    providerId: string | undefined,
    accountId: string | undefined,
    model: string,
  ): void => {
    void guard(async () => {
      if (active !== null) {
        await client.setSessionModel(active.id, {
          model,
          ...(accountId !== undefined ? { account: accountId } : {}),
        });
      } else {
        await client.putConfig({
          models: {
            default: model,
            ...(providerId !== undefined && accountId !== undefined
              ? { defaultAccount: { [providerId]: accountId } }
              : {}),
          },
        });
      }
      onDone();
    });
  };

  const addAccount = (
    providerId: string,
    accountId: string,
    label: string,
    key: string,
    baseUrl?: string,
  ): void => {
    void guard(async () => {
      await client.putAccount(providerId, accountId, {
        label,
        key,
        ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}),
      });
      onRefresh();
      setStep({ kind: "accounts", providerId });
    });
  };

  let dialog: React.ReactNode;
  if (step.kind === "providers") {
    dialog = (
      <SelectDialog
        key="providers"
        title="Providers"
        options={providerOptions(list.providers)}
        windowSize={windowSize}
        onPick={(value) => setStep({ kind: "accounts", providerId: value })}
        onClose={onDone}
      />
    );
  } else if (step.kind === "accounts") {
    const provider = findProvider(step.providerId);
    dialog =
      provider === undefined ? (
        <StepError message="Provider vanished" onClose={onDone} />
      ) : (
        <SelectDialog
          key={`accounts:${provider.id}`}
          title={`Accounts · ${provider.name}`}
          options={accountOptions(provider)}
          windowSize={windowSize}
          actions={[
            { key: "a", label: "add", onAction: () => setStep({ kind: "add-id", providerId: provider.id }) },
            {
              key: "d",
              label: "delete",
              onAction: (accountId) => {
                const account = provider.accounts.find((a) => a.id === accountId);
                if (account === undefined || account.source === "env") return; // env accounts aren't deletable
                void guard(async () => {
                  await client.deleteAccount(provider.id, accountId);
                  onRefresh();
                });
              },
            },
          ]}
          onPick={(accountId) => setStep({ kind: "models", providerId: provider.id, accountId })}
          onClose={() => setStep({ kind: "providers" })}
        />
      );
  } else if (step.kind === "add-id") {
    dialog = (
      <PromptDialog
        key={`add-id:${step.providerId}`}
        title={`New account · ${step.providerId}`}
        placeholder="account id (e.g. personal, work)"
        description="Multiple accounts per provider are fine — each keeps its own key."
        onSubmit={(accountId) => setStep({ kind: "add-label", providerId: step.providerId, accountId })}
        onClose={() => setStep({ kind: "accounts", providerId: step.providerId })}
      />
    );
  } else if (step.kind === "add-label") {
    dialog = (
      <PromptDialog
        key={`add-label:${step.accountId}`}
        title={`New account · ${step.accountId}`}
        placeholder="label (display name)"
        onSubmit={(label) => setStep({ kind: "add-key", providerId: step.providerId, accountId: step.accountId, label })}
        onClose={() => setStep({ kind: "add-id", providerId: step.providerId })}
      />
    );
  } else if (step.kind === "add-key") {
    const provider = findProvider(step.providerId);
    dialog = (
      <PromptDialog
        key={`add-key:${step.accountId}`}
        title={step.label}
        placeholder="API key"
        description="Stored in ~/.local/share/bai/auth.json (0600) — never synced."
        onSubmit={(key) => {
          // Catalog providers have known endpoints; builtins (stub) need none;
          // config/account-only providers without a baseUrl must be told where
          // to send requests.
          const needsUrl =
            provider !== undefined &&
            provider.baseUrl === undefined &&
            provider.source !== "catalog" &&
            provider.source !== "builtin";
          if (needsUrl) {
            setStep({
              kind: "add-url",
              providerId: step.providerId,
              accountId: step.accountId,
              label: step.label,
              key,
            });
          } else {
            addAccount(step.providerId, step.accountId, step.label, key);
          }
        }}
        onClose={() => setStep({ kind: "add-label", providerId: step.providerId, accountId: step.accountId })}
      />
    );
  } else if (step.kind === "add-url") {
    dialog = (
      <PromptDialog
        key={`add-url:${step.accountId}`}
        title="Base URL"
        placeholder="https://…/v1"
        description="This provider has no known endpoint — where should requests go?"
        optional
        onSubmit={(baseUrl) => addAccount(step.providerId, step.accountId, step.label, step.key, baseUrl)}
        onClose={() =>
          setStep({ kind: "add-key", providerId: step.providerId, accountId: step.accountId, label: step.label })
        }
      />
    );
  } else if (step.kind === "models") {
    const provider = findProvider(step.providerId);
    dialog =
      provider === undefined ? (
        <StepError message="Provider vanished" onClose={onDone} />
      ) : (
        <PagedModelPicker
          key={`models:${provider.id}:${step.accountId ?? ""}`}
          client={client}
          title={`Models · ${provider.name}${step.accountId !== undefined ? ` · ${step.accountId}` : ""}`}
          providerId={provider.id}
          preferZdr={preferZdr === true}
          windowSize={windowSize}
          onPick={(value) => {
            if (value === "__custom__") {
              setStep({ kind: "custom-model", providerId: provider.id, accountId: step.accountId });
            } else {
              applyModel(provider.id, step.accountId, value);
            }
          }}
          onClose={() => setStep({ kind: "accounts", providerId: provider.id })}
        />
      );
  } else if (step.kind === "all-models") {
    // Flat entry: every connected provider's models in one type-to-filter
    // list, paged server-side (the catalog is thousands strong). Account is
    // omitted on apply — the server resolves the provider's default
    // (config override → first stored → env).
    dialog = (
      <PagedModelPicker
        key="all-models"
        client={client}
        title="Models"
        preferZdr={preferZdr === true}
        windowSize={windowSize}
        onPick={(value) => {
          if (value === "__custom__") {
            setStep({ kind: "custom-model" });
          } else {
            applyModel(value.split("/")[0], undefined, value);
          }
        }}
        onClose={onDone}
      />
    );
  } else {
    dialog = (
      <PromptDialog
        key="custom-model"
        title="Model id"
        placeholder="e.g. openai/gpt-5-turbo"
        description="Sent to the provider verbatim — the catalog is a convenience, not a gate."
        onSubmit={(model) => applyModel(step.providerId, step.accountId, model)}
        onClose={() =>
          step.providerId !== undefined
            ? setStep({
                kind: "models",
                providerId: step.providerId,
                ...(step.accountId !== undefined ? { accountId: step.accountId } : {}),
              })
            : setStep({ kind: "all-models" })
        }
      />
    );
  }

  return (
    <Box flexDirection="column">
      {busy && <BusyLine />}
      {error !== null && <ErrorLine error={error} />}
      {dialog}
    </Box>
  );
}

/** Models per page (the flat catalog can be thousands strong). */
const MODEL_PAGE = 100;

/**
 * Server-paged model picker: fetches one page at a time from `/model`,
 * type-ahead filtering runs server-side (so it matches models beyond the
 * loaded page), and the next page loads as the highlight nears the end.
 * The custom "type a model id" escape hatch stays last.
 */
function PagedModelPicker({
  client,
  title,
  providerId,
  preferZdr,
  windowSize,
  onPick,
  onClose,
}: {
  client: BaiClient;
  title: string;
  /** Scope to one provider's models; omitted → the flat connected catalog. */
  providerId?: string;
  preferZdr: boolean;
  windowSize?: number;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<ModelPageEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const generationRef = useRef(0);
  const offsetRef = useRef(0);
  const queryRef = useRef("");
  const loadingMoreRef = useRef(false);

  const loadFirst = useCallback(
    async (query: string): Promise<void> => {
      const generation = ++generationRef.current;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      try {
        const page = await client.modelsPage({
          limit: MODEL_PAGE,
          offset: 0,
          ...(providerId !== undefined ? { provider: providerId } : {}),
          ...(query.length > 0 ? { q: query } : {}),
          ...(preferZdr ? { zdr: true } : {}),
        });
        if (generation !== generationRef.current) return;
        setEntries(page.models);
        offsetRef.current = page.nextOffset ?? page.models.length;
        setHasMore(page.hasMore === true);
        setTotal(page.total);
      } catch {
        // Advisory; keep whatever page is loaded.
      }
    },
    [client, providerId, preferZdr],
  );

  useEffect(() => {
    void loadFirst(queryRef.current);
  }, [loadFirst]);

  const loadMore = useCallback((): void => {
    if (!hasMore || loadingMoreRef.current) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await client.modelsPage({
          limit: MODEL_PAGE,
          offset: offsetRef.current,
          ...(providerId !== undefined ? { provider: providerId } : {}),
          ...(queryRef.current.length > 0 ? { q: queryRef.current } : {}),
          ...(preferZdr ? { zdr: true } : {}),
        });
        if (generation !== generationRef.current) return;
        setEntries((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...page.models.filter((m) => !seen.has(m.id))];
        });
        offsetRef.current = page.nextOffset ?? offsetRef.current + page.models.length;
        setHasMore(page.hasMore === true);
        setTotal(page.total);
      } catch {
        // Retry on the next scroll toward the end.
      } finally {
        if (generation === generationRef.current) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      }
    })();
  }, [client, providerId, preferZdr, hasMore]);

  const onQueryChange = useCallback(
    (query: string): void => {
      queryRef.current = query;
      void loadFirst(query);
    },
    [loadFirst],
  );

  const options = [
    ...modelPageOptions(entries, preferZdr, providerId === undefined),
    {
      value: "__custom__",
      label: "Type a model id…",
      hint: providerId === undefined ? "provider/model" : "any id accepted",
    },
  ];

  return (
    <SelectDialog
      title={title}
      options={options}
      windowSize={windowSize}
      emptyHint="no models"
      onQueryChange={onQueryChange}
      hasMore={hasMore}
      loadingMore={loadingMore}
      total={total}
      onLoadMore={loadMore}
      onPick={onPick}
      onClose={onClose}
    />
  );
}

function BusyLine() {
  const t = useTheme();
  return <Text color={t.dim}>working…</Text>;
}

function ErrorLine({ error }: { error: string }) {
  const t = useTheme();
  return <Text color={t.danger}>error: {error}</Text>;
}

function StepError({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <SelectDialog
      title="Error"
      options={[{ value: "close", label: message }]}
      onPick={onClose}
      onClose={onClose}
    />
  );
}
