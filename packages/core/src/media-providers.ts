/**
 * `MEDIA_PROVIDER_SPECS` + `mediaProviderSpec` moved to `@bai/shared` so the
 * extracted `@bai/provider` package can use them without depending on core.
 * Re-exported here so `core/src/index.ts` and `workbench/media/registry.ts`
 * (and their tests) are unchanged.
 */
export {
  MEDIA_PROVIDER_SPECS,
  mediaProviderSpec,
  mediaProviderSpecForKind,
  mediaProviderSpecsForKind,
  type MediaProviderSpec,
} from "@bai/shared";
