# @bai/provider

The model-provider subsystem, extracted out of `@bai/core` so it stays a
focused, transport-free domain package. Depends only on `@bai/shared`.

It exposes both the low-level provider layer and the **router SDK** — the one
seam every surface uses to resolve a model to an adapter + credentials and
stream a turn.

## Responsibilities

- **Adapters** (`src/adapters/`) — the only files that touch vendor wire
  protocols/SDKs: OpenAI-compatible (`openai.ts`), Anthropic Messages
  (`anthropic.ts`), and the OpenAI Responses API (`responses.ts`, serving
  ChatGPT/Codex + xAI). Vendor types never leak past these files.
- **`ProviderRegistry`** (`src/registry.ts`) — the single choke point:
  `resolveModel("provider/model")`, `resolveCredentials(providerId, account)`
  (account → env → config → keyless, with OAuth refresh), `listProviders()`,
  `allModels()`, `usageRates()`.
- **`ModelRouter`** (`src/router.ts`) — the router SDK: wraps `ProviderRegistry`
  with `resolve()` / `chat()` and the adapter-facing `auth` object. Used
  in-process by core's run loop and by the `@bai/router` HTTP gateway.
- **Catalog** (`src/catalog.ts`) — models.dev (live ⊕ offline snapshot) ⊕ a
  curated overlay (`overlay.ts`) ⊕ config-defined providers ⊕ file-defined
  providers (`file-registry.ts`, `~/.config/bai/providers/*.json`).
- **Credentials** (`src/auth-store.ts`) — `auth.json` (0600) multi-account
  API keys + OAuth token records.
- **OAuth logins** (`src/oauth/`) — a server-side login engine: per-provider
  specs (`oauth/providers/`), device-code (`device.ts`), paste-code PKCE
  (`redirect.ts`, `pkce.ts`), single-flight refresh (`refresh.ts`), and the
  `OAuthLoginManager` driving start/poll/submit/cancel.
- **Shared helpers** — `small-model.ts` (`pickSmallModel`), `retry.ts`,
  `tool-names.ts`, `output-limit.ts`, `stub.ts` (keyless echo provider).

## Non-goals

- Transport/HTTP (→ `@bai/api`, `@bai/router`).
- Media/image adapters (→ `@bai/core` workbench).
- Session/run orchestration (→ `@bai/core`).

## Notes

- `@bai/core` re-exports this package (`export * from "@bai/provider"`), so
  existing importers keep working; new code should import `@bai/provider`
  directly.
- Cross-cutting values live in `@bai/shared` (`UsageRates`/`ZERO_RATES`,
  `MEDIA_PROVIDER_SPECS`, `stripJsonComments`) so core and provider can share
  them without a cycle.
