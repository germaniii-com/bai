import type { ModelInfo, ProviderInfo, ProviderListResponse, UsageRates } from "@bai/shared";
import type { ProviderRegistry, ResolvedCredentials } from "./registry";
import type { LlmRequest, OutboundMessage, Provider, ProviderStream, ToolDef } from "./types";

/**
 * A fully-resolved routing target: which provider adapter, which vendor model,
 * which saved account, and the request-scoped credentials to send.
 */
export interface RouteTarget {
  providerId: string;
  /** Vendor model id (the `provider/` prefix stripped). */
  model: string;
  adapter: Provider;
  account?: string;
  credentials: ResolvedCredentials;
  /** The `LlmRequest.auth` object adapters consume (secret-bearing). */
  auth: NonNullable<LlmRequest["auth"]>;
  reasoning: boolean;
  contextWindow?: number;
  supportsAttachments?: boolean;
  inputModalities?: string[];
}

export interface ChatRouteOptions {
  tools?: ToolDef[];
  params?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

/**
 * The **SDK version of the router**: one seam that resolves a
 * `provider/model` id + optional account to a live adapter + credentials, and
 * streams a chat turn. bai's in-process run loop and the `@bai/router` HTTP
 * gateway both go through this, so routing semantics (credential precedence,
 * OAuth renewal, adapter selection) never diverge.
 */
export class ModelRouter {
  constructor(private readonly registry: ProviderRegistry) {}

  /** Resolve `provider/model` (+ account) → adapter, model, credentials, auth. */
  async resolve(modelId: string, account?: string): Promise<RouteTarget> {
    const resolved = await this.registry.resolveModel(modelId);
    const chosen = account ?? (await this.registry.defaultAccount(resolved.providerId));
    const credentials = await this.registry.resolveCredentials(resolved.providerId, chosen);
    return {
      providerId: resolved.providerId,
      model: resolved.model,
      adapter: resolved.provider,
      ...(chosen !== undefined ? { account: chosen } : {}),
      credentials,
      auth: authFromCredentials(credentials),
      reasoning: resolved.reasoning,
      ...(resolved.contextWindow !== undefined ? { contextWindow: resolved.contextWindow } : {}),
      ...(resolved.supportsAttachments !== undefined
        ? { supportsAttachments: resolved.supportsAttachments }
        : {}),
      ...(resolved.inputModalities !== undefined ? { inputModalities: resolved.inputModalities } : {}),
    };
  }

  /** Resolve a target and stream one chat turn through its adapter. */
  async chat(
    modelId: string,
    account: string | undefined,
    messages: OutboundMessage[],
    opts: ChatRouteOptions = {},
  ): Promise<{ target: RouteTarget; stream: ProviderStream }> {
    const target = await this.resolve(modelId, account);
    const request: LlmRequest = {
      model: target.model,
      messages,
      auth: target.auth,
      ...(opts.tools !== undefined && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      ...(opts.params !== undefined ? { params: opts.params } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };
    const stream = await target.adapter.stream(request);
    return { target, stream };
  }

  models(): Promise<ModelInfo[]> {
    return this.registry.allModels();
  }

  providers(): Promise<ProviderInfo[]> {
    return this.registry.listProviders();
  }

  /** Epoch-ms stamp of the catalog's last models.dev fetch (0 = never). */
  catalogUpdatedAt(): number {
    return this.registry.catalogUpdatedAt();
  }

  listResponse(): Promise<ProviderListResponse> {
    return this.registry.listResponse();
  }

  usageRates(providerId: string, model: string): Promise<UsageRates> {
    return this.registry.usageRates(providerId, model);
  }
}

/**
 * Build the adapter-facing `auth` object. Only the fields an adapter may see
 * are forwarded: `refreshToken`/`expiresAt` stay inside the registry (OAuth
 * renewal happens in `resolveCredentials`).
 */
function authFromCredentials(credentials: ResolvedCredentials): NonNullable<LlmRequest["auth"]> {
  return {
    ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}),
    ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
    ...(credentials.oauth !== undefined ? { oauth: credentials.oauth } : {}),
    ...(credentials.oauthAccountId !== undefined ? { oauthAccountId: credentials.oauthAccountId } : {}),
    ...(credentials.headers !== undefined ? { headers: credentials.headers } : {}),
  };
}
