import type { OAuthProviderInfo } from "@bai/shared";
import type { AuthStore } from "../auth-store";
import type { OAuthFlowSpec } from "./types";
import { codexSpec } from "./providers/codex";
import { xaiSpec } from "./providers/xai";
import { nousSpec } from "./providers/nous";
import { copilotSpec } from "./providers/copilot";
import { anthropicSpec } from "./providers/anthropic";
import { minimaxSpec } from "./providers/minimax";
import { qwenSpec } from "./providers/qwen";
import { vertexSpec } from "./providers/vertex";

/** Every provider bai can log into, keyed by provider id. */
export const OAUTH_SPECS: Record<string, OAuthFlowSpec> = {
  [codexSpec.id]: codexSpec,
  [xaiSpec.id]: xaiSpec,
  [nousSpec.id]: nousSpec,
  [copilotSpec.id]: copilotSpec,
  [anthropicSpec.id]: anthropicSpec,
  [minimaxSpec.id]: minimaxSpec,
  [qwenSpec.id]: qwenSpec,
  [vertexSpec.id]: vertexSpec,
};

export function oauthSpec(providerId: string): OAuthFlowSpec | undefined {
  return OAUTH_SPECS[providerId];
}

/** Public projection of the login-capable providers + connection state. */
export function oauthProviders(specs: Record<string, OAuthFlowSpec>, accounts: AuthStore): OAuthProviderInfo[] {
  return Object.values(specs)
    .map((spec) => ({
      id: spec.id,
      name: spec.name,
      method: spec.method,
      connected: accounts.hasOAuth(spec.id),
      defaultAccount: spec.accountId ?? "oauth",
      ...(spec.hint !== undefined ? { hint: spec.hint } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
