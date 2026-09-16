import type { OAuthFlowSpec, OAuthFlowContext, OAuthRefreshContext, OAuthTokens } from "../types";

/**
 * Google Vertex AI — Application Default Credentials (or a service-account
 * JSON) minted to an OAuth2 bearer via `google-auth-library`. The endpoint is
 * project/region specific, so the flow publishes a computed `baseUrl`.
 */
export function vertexRegion(): string {
  return process.env.VERTEX_REGION ?? "global";
}

export function buildVertexBaseUrl(projectId: string, region: string): string {
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${projectId}/locations/${region}/endpoints/openapi`;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

async function mintVertexToken(): Promise<OAuthTokens> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: [SCOPE] });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const access = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
  if (typeof access !== "string" || access.length === 0) {
    throw new Error("Vertex ADC did not yield an access token");
  }
  const projectId =
    process.env.VERTEX_PROJECT_ID ?? (await auth.getProjectId().catch(() => undefined)) ?? process.env.GOOGLE_CLOUD_PROJECT;
  const region = vertexRegion();
  const baseUrl = projectId !== undefined && projectId.length > 0 ? buildVertexBaseUrl(projectId, region) : undefined;
  return {
    access,
    // Google access tokens default to 1h; renew with a 5-minute margin.
    expiresAt: Date.now() + 55 * 60 * 1000,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

async function login(_ctx: OAuthFlowContext): Promise<OAuthTokens> {
  try {
    return await mintVertexToken();
  } catch (err) {
    throw new Error(
      `Vertex credentials unavailable — set GOOGLE_APPLICATION_CREDENTIALS (service-account JSON) or run \`gcloud auth application-default login\`. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function refresh(_tokens: { access: string; refresh?: string; idToken?: string }, _ctx: OAuthRefreshContext): Promise<OAuthTokens> {
  return mintVertexToken();
}

export const vertexSpec: OAuthFlowSpec = {
  id: "vertex",
  name: "Google Vertex AI",
  method: "adc",
  hint: "Uses Application Default Credentials / a service-account JSON",
  accountId: "adc",
  run: login,
  refresh,
};
