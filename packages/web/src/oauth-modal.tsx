import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import { suggestAccountId, type OAuthLoginSession, type OAuthStartMode } from "@bai/shared";
import { Button, Field, Modal, TextInput } from "./components";

const POLL_MS = 1500;

/** True when this page is served from the same machine as the bai server. */
function isLocalClient(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * OAuth login modal.
 *
 *  - redirect (local only): opens the provider's login page in a new tab; the
 *    provider redirects back to bai's loopback callback and the account lands
 *    automatically. No code to copy.
 *  - device_code: shows the one-time code and opens the verification page.
 *  - paste_code: opens the authorization page and accepts the pasted code
 *    (used when a remote client cannot reach bai's loopback callback).
 *
 * The first step names the account, so a provider can hold several OAuth
 * accounts (e.g. `work`, `personal`) — each is a distinct `auth.json` record.
 * Tokens never reach the browser.
 */
export function OAuthModal({
  client,
  provider,
  providerName,
  defaultAccount,
  intent = "connect",
  accountId,
  existingAccounts,
  onClose,
  onConnected,
  onNotice,
}: {
  client: BaiClient;
  provider: string;
  providerName: string;
  /** Prefilled account id (the provider's default) from the OAuth catalog. */
  defaultAccount?: string;
  /**
   * `connect` targets the provider default (name step), `add` creates a new
   * named account, `reconnect` refreshes one specific `accountId` in place.
   */
  intent?: "connect" | "add" | "reconnect";
  /** Account id to reconnect (required for `intent: "reconnect"`). */
  accountId?: string;
  /** Existing OAuth account ids (collision → explicit replace). */
  existingAccounts?: string[];
  onClose: () => void;
  onConnected: () => void;
  onNotice: (message: string, kind?: "success" | "error") => void;
}) {
  const existing = existingAccounts ?? [];
  const reconnect = intent === "reconnect";
  const [phase, setPhase] = useState<"name" | "login">(reconnect ? "login" : "name");
  const [accountName, setAccountName] = useState(() =>
    intent === "add" ? suggestAccountId(existing, defaultAccount ?? "account") : (defaultAccount ?? ""),
  );
  const [session, setSession] = useState<OAuthLoginSession | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);
  const openedRef = useRef<string | null>(null);
  const accountRef = useRef(reconnect ? (accountId ?? defaultAccount ?? "") : accountName);

  const trimmedName = accountName.trim();
  const collides = trimmedName.length > 0 && existing.some((id) => id.toLowerCase() === trimmedName.toLowerCase());
  const nameRequired = intent === "add" && trimmedName.length === 0;

  const connect = useCallback(
    async (mode: OAuthStartMode) => {
      setBusy(true);
      setError(null);
      try {
        const account = accountRef.current.trim();
        setSession(await client.startOAuth(provider, { mode, ...(account.length > 0 ? { account } : {}) }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [client, provider],
  );

  useEffect(() => {
    if (phase !== "login") return;
    // Local clients prefer the browser redirect; remote clients (phone hitting
    // a `--host` server) must use the device/paste fallback because the
    // loopback callback lives on the server's machine.
    const mode: OAuthStartMode = isLocalClient() ? "auto" : "device";
    void connect(mode);
  }, [phase, connect]);

  // Once a URL is available, open the provider's login page in a new tab
  // (redirect authorize URL or device verification page). Rendering a manual
  // link below covers popup-blocked cases.
  const openUrl = session?.authorizeUrl ?? session?.verificationUriComplete ?? session?.verificationUri;
  useEffect(() => {
    if (openUrl === undefined || openedRef.current === openUrl) return;
    openedRef.current = openUrl;
    window.open(openUrl, "_blank", "noopener,noreferrer");
  }, [openUrl]);

  useEffect(() => {
    if (session === null) return;
    if (session.status !== "pending" && session.status !== "awaiting_code") return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await client.pollOAuth(provider, session.id);
          setSession(next);
          if (next.status === "error" || next.status === "expired") setError(next.error ?? next.status);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [client, provider, session]);

  const approved = session?.status === "approved";
  useEffect(() => {
    if (approved && !doneRef.current) {
      doneRef.current = true;
      onConnected();
      onNotice(`Connected ${providerName}${accountRef.current.trim().length > 0 ? ` (${accountRef.current.trim()})` : ""}`);
    }
  }, [approved, onConnected, onNotice, providerName]);

  /** Abandon a stuck redirect and restart on the code/device path. */
  const useCodeInstead = (): void => {
    if (session !== null) void client.cancelOAuth(provider, session.id).catch(() => undefined);
    openedRef.current = null;
    void connect("device");
  };

  const submitCode = (): void => {
    if (session === null || code.trim().length === 0) return;
    void (async () => {
      try {
        setSession(await client.submitOAuth(provider, session.id, code.trim()));
        setCode("");
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  const cancel = (): void => {
    if (session !== null) void client.cancelOAuth(provider, session.id).catch(() => undefined);
    onClose();
  };

  /** Re-open the provider login tab (redirect / device / paste all report one). */
  const openLogin = (): void => {
    if (openUrl !== undefined) window.open(openUrl, "_blank", "noopener,noreferrer");
  };

  const startLogin = (): void => {
    accountRef.current = accountName;
    setPhase("login");
  };

  return (
    <Modal
      open
      onClose={cancel}
      title={`${reconnect ? "Reconnect" : "Connect"} ${providerName}`}
      size="sm"
      footer={
        <Button variant="ghost" onClick={cancel}>
          {approved ? "Close" : "Cancel"}
        </Button>
      }
    >
      {error !== null && <p className="error">{error}</p>}

      {phase === "name" ? (
        <>
          <p className="dim">
            {intent === "add"
              ? `Add another ${providerName} account. Give it a unique name (e.g. work, personal).`
              : `Name this account to keep several for ${providerName} (e.g. work, personal). Adding a new name creates a second account; reusing one replaces it.`}
          </p>
          <Field
            label="Account name"
            error={collides ? `"${trimmedName}" already exists — continuing will replace it.` : null}
          >
            <TextInput
              value={accountName}
              placeholder={defaultAccount ?? "account"}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </Field>
          <Button variant="primary" onClick={startLogin} disabled={nameRequired}>
            {collides ? "Replace account" : intent === "add" ? "Add account" : "Continue"}
          </Button>
        </>
      ) : (
        <>
          {busy && session === null && <p className="dim">Starting…</p>}

          {approved ? (
            <p className="success">Connected — {providerName} is ready.</p>
          ) : (
            <>
              {session?.method === "redirect" && (
                <>
                  <p className="dim">
                    Complete the sign-in in the browser tab. This window finishes automatically when the
                    provider redirects back.
                  </p>
                  {openUrl !== undefined && (
                    <Button variant="primary" onClick={openLogin}>
                      Continue to {providerName} login
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={useCodeInstead}>
                    Trouble? Use a code instead
                  </Button>
                </>
              )}

              {session?.method === "device_code" && session.userCode !== undefined && (
                <>
                  <p>
                    Enter this code on the verification page:
                    <br />
                    <strong className="oauth-code">{session.userCode}</strong>
                  </p>
                  {openUrl !== undefined && (
                    <Button variant="primary" onClick={openLogin}>
                      Open verification page
                    </Button>
                  )}
                </>
              )}

              {session?.method === "paste_code" && (
                <>
                  <p className="dim">{session.instructions ?? "Paste the code shown after approving."}</p>
                  {openUrl !== undefined && (
                    <Button variant="outline" onClick={openLogin}>
                      Open authorization page
                    </Button>
                  )}
                  <Field label="Authorization code">
                    <TextInput value={code} placeholder="code#state" onChange={(e) => setCode(e.target.value)} />
                  </Field>
                  <Button variant="primary" onClick={submitCode} disabled={code.trim().length === 0}>
                    Submit code
                  </Button>
                </>
              )}

              {(session?.method === "import" || session?.method === "adc") && (
                <p className="dim">{session.instructions ?? "Reading local credentials…"}</p>
              )}

              {session !== null && session.status === "pending" && session.method !== "paste_code" && (
                <p className="dim">Waiting for sign-in…</p>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
