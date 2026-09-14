import { Box, Text } from "ink";
import { spawn } from "node:child_process";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { ModelPageEntry, OAuthLoginSession, OAuthProviderInfo, OAuthStartMode, ProviderInfo, ProviderListResponse, Session } from "@bai/shared";
import { suggestAccountId } from "@bai/shared";
import { PromptDialog, SelectDialog } from "./dialog";
import { useTheme } from "../theme";
import { accountActionOptions, accountListOptions, modelPageOptions, providerOptions } from "../state/providers";

/**
 * Provider wizard (the opencode /connect pattern, extended for multi-account,
 * OAuth logins, and custom endpoints): provider list → account management
 * (add/remove/select/connect-OAuth) → model picker → apply to the active
 * session (or the global default when none is open). Each step replaces the
 * last; esc backs out one level.
 *
 * The Switch model command (supermenu / hub model chip) skips the provider
 * step, opening at the flat `all-models` step via `initialStep`.
 */
type Step =
  | { kind: "providers" }
  | { kind: "accounts"; providerId: string }
  | { kind: "account"; providerId: string; accountId: string }
  | { kind: "add-id"; providerId: string }
  | { kind: "add-label"; providerId: string; accountId: string }
  | { kind: "add-key"; providerId: string; accountId: string; label: string }
  | { kind: "add-url"; providerId: string; accountId: string; label: string; key: string }
  | { kind: "models"; providerId: string; accountId?: string }
  | { kind: "all-models" }
  | { kind: "custom-model"; providerId?: string; accountId?: string }
  | { kind: "oauth-account"; providerId: string; intent: "reconnect" | "add" }
  | { kind: "oauth"; providerId: string; accountId?: string }
  | { kind: "custom-id" }
  | { kind: "custom-url"; providerId: string }
  | { kind: "custom-models"; providerId: string; baseUrl: string };

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
  const [oauth, setOauth] = useState<OAuthProviderInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void client
      .oauthProviders()
      .then((providers) => {
        if (!cancelled) setOauth(providers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const findProvider = (id: string): ProviderInfo | undefined => list.providers.find((p) => p.id === id);
  const oauthFor = (id: string): OAuthProviderInfo | undefined => oauth.find((o) => o.id === id);

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

  const createCustom = (providerId: string, baseUrl: string, models: string[]): void => {
    void guard(async () => {
      await client.putCustomProvider(providerId, {
        baseUrl,
        adapter: "openai-compatible",
        ...(models.length > 0 ? { models } : {}),
      });
      onRefresh();
      setStep({ kind: "accounts", providerId });
    });
  };

  let dialog: React.ReactNode;
  if (step.kind === "providers") {
    const oauthIds = new Set(oauth.map((o) => o.id));
    dialog = (
      <SelectDialog
        key="providers"
        title="Providers"
        options={providerOptions(list.providers, oauthIds)}
        windowSize={windowSize}
        actions={[{ key: "n", label: "custom provider", onAction: () => setStep({ kind: "custom-id" }) }]}
        onPick={(value) => setStep({ kind: "accounts", providerId: value })}
        onClose={onDone}
      />
    );
  } else if (step.kind === "accounts") {
    const provider = findProvider(step.providerId);
    const oauthInfo = oauthFor(step.providerId);
    // Accounts first once connected (the user picks one → account actions);
    // before that, the OAuth connect / add rows lead so the browser login is
    // reachable with plain Enter (not only the ctrl+o chord).
    dialog =
      provider === undefined ? (
        <StepError message="Provider vanished" onClose={onDone} />
      ) : (
        <SelectDialog
          key={`accounts:${provider.id}`}
          title={`Accounts · ${provider.name}`}
          options={accountListOptions(provider, oauthInfo)}
          windowSize={windowSize}
          emptyHint={oauthInfo !== undefined ? "ctrl+o to connect" : "none yet — ctrl+a to add"}
          actions={[
            { key: "a", label: "add key", onAction: () => setStep({ kind: "add-id", providerId: provider.id }) },
            ...(oauthInfo !== undefined
              ? [
                  {
                    key: "o",
                    // Reconnecting is per-account (inside the account's action
                    // step); here the chord connects or adds another account.
                    label: oauthInfo.connected ? "add oauth account" : "connect oauth",
                    onAction: () =>
                      setStep({
                        kind: "oauth-account",
                        providerId: provider.id,
                        intent: oauthInfo.connected ? "add" : "reconnect",
                      }),
                  },
                ]
              : []),
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
          onPick={(value) => {
            if (value === "__oauth__") {
              setStep({ kind: "oauth-account", providerId: provider.id, intent: "reconnect" });
            } else if (value === "__oauth_add__") {
              setStep({ kind: "oauth-account", providerId: provider.id, intent: "add" });
            } else {
              // An account is a step: choose the account, then an action.
              setStep({ kind: "account", providerId: provider.id, accountId: value });
            }
          }}
          onClose={() => setStep({ kind: "providers" })}
        />
      );
  } else if (step.kind === "account") {
    const provider = findProvider(step.providerId);
    const oauthInfo = oauthFor(step.providerId);
    const account = provider?.accounts.find((a) => a.id === step.accountId);
    dialog =
      provider === undefined || account === undefined ? (
        <StepError
          message="Account vanished"
          onClose={() => setStep({ kind: "accounts", providerId: step.providerId })}
        />
      ) : (
        <SelectDialog
          key={`account:${provider.id}:${account.id}`}
          title={`${account.label} · ${provider.name}`}
          options={accountActionOptions(account, oauthInfo !== undefined)}
          windowSize={windowSize}
          actions={
            account.source !== "env"
              ? [
                  {
                    key: "d",
                    label: "remove account",
                    onAction: () => {
                      void guard(async () => {
                        await client.deleteAccount(provider.id, account.id);
                        onRefresh();
                        setStep({ kind: "accounts", providerId: provider.id });
                      });
                    },
                  },
                ]
              : []
          }
          onPick={(value) => {
            if (value === "__oauth__") {
              // Reconnect this exact account in place.
              setStep({ kind: "oauth", providerId: provider.id, accountId: account.id });
            } else {
              setStep({ kind: "models", providerId: provider.id, accountId: account.id });
            }
          }}
          onClose={() => setStep({ kind: "accounts", providerId: provider.id })}
        />
      );
  } else if (step.kind === "oauth-account") {
    const oauthInfo = oauthFor(step.providerId);
    const provider = findProvider(step.providerId);
    const existing = provider?.accounts.filter((a) => a.source === "oauth").map((a) => a.id) ?? [];
    const suggestion = suggestAccountId(existing, oauthInfo?.defaultAccount ?? "account");
    dialog = (
      <PromptDialog
        key={`oauth-account:${step.providerId}:${step.intent}`}
        title={`${step.intent === "add" ? "Add account" : "Account name"} · ${provider?.name ?? step.providerId}`}
        placeholder={step.intent === "add" ? suggestion : (oauthInfo?.defaultAccount ?? "account name")}
        description={
          step.intent === "add"
            ? "Name the new account (e.g. work, personal) — it must differ from the existing ones."
            : "Optional. Name it to keep several accounts; an existing name is replaced."
        }
        optional={step.intent !== "add"}
        onSubmit={(accountId) => {
          const typed = accountId.trim();
          const name = typed.length > 0 ? typed : step.intent === "add" ? suggestion : undefined;
          setStep({
            kind: "oauth",
            providerId: step.providerId,
            ...(name !== undefined ? { accountId: name } : {}),
          });
        }}
        onClose={() => setStep({ kind: "accounts", providerId: step.providerId })}
      />
    );
  } else if (step.kind === "oauth") {
    dialog = (
      <OAuthStep
        key={`oauth:${step.providerId}:${step.accountId ?? ""}`}
        client={client}
        providerId={step.providerId}
        accountId={step.accountId}
        providerName={findProvider(step.providerId)?.name ?? step.providerId}
        onDone={() => {
          onRefresh();
          setStep({ kind: "accounts", providerId: step.providerId });
        }}
        onClose={() => setStep({ kind: "accounts", providerId: step.providerId })}
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
  } else if (step.kind === "custom-model") {
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
  } else if (step.kind === "custom-id") {
    dialog = (
      <PromptDialog
        key="custom-id"
        title="Custom provider"
        placeholder="provider id (e.g. my-gateway)"
        description="Lowercase slug; creates a config-defined provider."
        onSubmit={(providerId) => setStep({ kind: "custom-url", providerId: providerId.trim().toLowerCase() })}
        onClose={() => setStep({ kind: "providers" })}
      />
    );
  } else if (step.kind === "custom-url") {
    dialog = (
      <PromptDialog
        key="custom-url"
        title={`Base URL · ${step.providerId}`}
        placeholder="https://gateway.example.com/v1"
        onSubmit={(baseUrl) => setStep({ kind: "custom-models", providerId: step.providerId, baseUrl })}
        onClose={() => setStep({ kind: "custom-id" })}
      />
    );
  } else {
    dialog = (
      <PromptDialog
        key="custom-models"
        title={`Models · ${step.providerId}`}
        placeholder="model-a, model-b (optional)"
        description="Comma-separated model ids. Press enter to finish."
        optional
        onSubmit={(models) =>
          createCustom(
            step.providerId,
            step.baseUrl,
            models
              .split(",")
              .map((m) => m.trim())
              .filter((m) => m.length > 0),
          )
        }
        onClose={() => setStep({ kind: "custom-url", providerId: step.providerId })}
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

/**
 * Drives one server-side OAuth login. Redirect flows open the provider's login
 * page in the system browser and finish when the provider calls back to bai's
 * loopback server; device-code flows show the one-time code + verification URL
 * (also opened); paste-code flows ask for the code; import/adc run immediately.
 */
function OAuthStep({
  client,
  providerId,
  accountId,
  providerName,
  onDone,
  onClose,
}: {
  client: BaiClient;
  providerId: string;
  /** Account id to write on approval (omitted → provider default). */
  accountId?: string;
  providerName: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [session, setSession] = useState<OAuthLoginSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<OAuthStartMode>("auto");
  const doneRef = useRef(false);
  const openedRef = useRef<string | null>(null);

  useEffect(() => {
    void client
      .startOAuth(providerId, { mode, ...(accountId !== undefined ? { account: accountId } : {}) })
      .then(setSession)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [client, providerId, accountId, mode]);

  useEffect(() => {
    if (session === null) return;
    if (session.status !== "pending" && session.status !== "awaiting_code") return;
    const timer = setInterval(() => {
      void client
        .pollOAuth(providerId, session.id)
        .then((next) => {
          setSession(next);
          if (next.status === "error" || next.status === "expired") setError(next.error ?? next.status);
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [client, providerId, session]);

  // Open the browser automatically the first time a URL appears (redirect
  // authorize URL, or the device verification page).
  const openUrl = session?.authorizeUrl ?? session?.verificationUriComplete ?? session?.verificationUri;
  useEffect(() => {
    if (openUrl === undefined || openedRef.current === openUrl) return;
    openedRef.current = openUrl;
    openInBrowser(openUrl);
  }, [openUrl]);

  useEffect(() => {
    if (session?.status === "approved" && !doneRef.current) {
      doneRef.current = true;
      onDone();
    }
  }, [session, onDone]);

  /** Abandon a stuck redirect and restart on the device/paste path. */
  const retryWithCode = (): void => {
    if (session !== null) void client.cancelOAuth(providerId, session.id).catch(() => undefined);
    openedRef.current = null;
    setError(null);
    setMode("device");
  };

  if (error !== null) return <StepError message={error} onClose={onClose} />;
  if (session === null) return <BusyLine label={`starting ${providerName} login…`} />;

  if (session.method === "paste_code" && session.status === "awaiting_code") {
    return (
      <PromptDialog
        key="oauth-code"
        title={`Connect ${providerName}`}
        placeholder="Authorization code (code#state)"
        description={`Open ${session.authorizeUrl ?? "the authorization page"} then paste the code shown.`}
        onSubmit={(value) => {
          void client
            .submitOAuth(providerId, session.id, value.trim())
            .then(setSession)
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        }}
        onClose={onClose}
      />
    );
  }

  const lines: string[] = [];
  if (session.userCode !== undefined) lines.push(`code: ${session.userCode}`);
  if (session.verificationUriComplete !== undefined) lines.push(`open: ${session.verificationUriComplete}`);
  else if (session.verificationUri !== undefined) lines.push(`open: ${session.verificationUri}`);
  if (session.authorizeUrl !== undefined) lines.push(`open: ${session.authorizeUrl}`);
  if (session.instructions !== undefined) lines.push(session.instructions);
  lines.push(session.status === "approved" ? "connected" : "waiting…");

  return (
    <SelectDialog
      key="oauth-status"
      title={`Connect ${providerName}`}
      options={[{ value: "wait", label: lines.join("  ·  "), hint: session.status }]}
      actions={
        session.method === "redirect" && session.status !== "approved"
          ? [{ key: "r", label: "use code instead", onAction: retryWithCode }]
          : []
      }
      onPick={onClose}
      onClose={onClose}
    />
  );
}

/** Open a URL in the OS default browser (best effort, detached). */
function openInBrowser(url: string): void {
  try {
    let cmd = "xdg-open";
    let args: string[] = [url];
    if (process.platform === "darwin") {
      cmd = "open";
    } else if (process.platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Headless / no browser: the URL is still shown in the dialog.
  }
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

function BusyLine({ label = "working…" }: { label?: string }) {
  const t = useTheme();
  return <Text color={t.dim}>{label}</Text>;
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
