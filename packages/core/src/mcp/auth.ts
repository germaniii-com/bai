import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";

/** Persisted per-server OAuth state (tokens, client registration, PKCE verifier). */
export interface McpAuthRecord {
  tokens?: Record<string, unknown>;
  clientInformation?: Record<string, unknown>;
  codeVerifier?: string;
  /** Last authorization URL handed to the user (for the UI to open). */
  authorizationUrl?: string;
}

/**
 * OAuth credential storage for MCP servers:
 * `~/.local/share/bai/mcp-tokens/<server>.json`, mode 0600. Kept out of
 * config so secrets never ride config sync.
 */
export class McpAuthStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(server: string): string {
    return path.join(this.dir, `${server}.json`);
  }

  read(server: string): McpAuthRecord {
    const file = this.file(server);
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8")) as McpAuthRecord;
    } catch {
      return {};
    }
  }

  write(server: string, record: McpAuthRecord): void {
    const file = this.file(server);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }

  clear(server: string): void {
    const file = this.file(server);
    if (existsSync(file)) writeFileSync(file, "{}\n", { mode: 0o600 });
  }

  /** Drop only the cached Dynamic Client Registration (forces a fresh DCR). */
  clearClientInformation(server: string): void {
    const record = this.read(server);
    delete record.clientInformation;
    this.write(server, record);
  }

  /** Forget the last captured authorization URL (avoids returning a stale one). */
  clearAuthorizationUrl(server: string): void {
    const record = this.read(server);
    delete record.authorizationUrl;
    this.write(server, record);
  }
}

export interface McpOAuthProviderOptions {
  server: string;
  store: McpAuthStore;
  redirectUrl: string;
  /** Optional static client registration from config. */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /** `client_name` sent during Dynamic Client Registration (default "bai"). */
  clientName?: string;
}

/**
 * Build an SDK `OAuthClientProvider` backed by `McpAuthStore`. `state` and the
 * PKCE verifier are persisted so a paste-the-code flow survives a restart.
 */
export function createOAuthProvider(opts: McpOAuthProviderOptions): OAuthClientProvider {
  const { server, store, redirectUrl } = opts;
  const provider = {
    get redirectUrl(): string {
      return redirectUrl;
    },
    get clientMetadata(): unknown {
      return {
        client_name: opts.clientName ?? "bai",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: opts.clientSecret !== undefined ? "client_secret_basic" : "none",
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      };
    },
    state(): string {
      const state = crypto.randomUUID().replace(/-/g, "");
      const record = store.read(server);
      store.write(server, { ...record, codeVerifier: record.codeVerifier });
      return state;
    },
    clientInformation(): unknown {
      const record = store.read(server);
      if (record.clientInformation !== undefined) return record.clientInformation;
      if (opts.clientId !== undefined) {
        return {
          client_id: opts.clientId,
          ...(opts.clientSecret !== undefined ? { client_secret: opts.clientSecret } : {}),
        };
      }
      return undefined;
    },
    saveClientInformation(clientInformation: unknown): void {
      store.write(server, { ...store.read(server), clientInformation: clientInformation as Record<string, unknown> });
    },
    tokens(): unknown {
      return store.read(server).tokens;
    },
    saveTokens(tokens: unknown): void {
      store.write(server, { ...store.read(server), tokens: tokens as Record<string, unknown> });
    },
    redirectToAuthorization(url: URL): void {
      store.write(server, { ...store.read(server), authorizationUrl: url.toString() });
    },
    saveCodeVerifier(codeVerifier: string): void {
      store.write(server, { ...store.read(server), codeVerifier });
    },
    codeVerifier(): string {
      const verifier = store.read(server).codeVerifier;
      if (verifier === undefined) throw new Error("No PKCE code verifier saved for this MCP server");
      return verifier;
    },
    invalidateCredentials(): void {
      store.clear(server);
    },
  };
  return provider as unknown as OAuthClientProvider;
}
