/**
 * Version stamp: `BAI_VERSION` is injected at compile time via `define`
 * (see scripts/compile.ts — the analog of Go's -ldflags -X). Falls back to
 * the package version when running from source. Kept in its own leaf module so
 * lightweight paths (the `bai mcp` stdio bridge) can read it without loading
 * the composition root.
 */
declare const BAI_VERSION: string | undefined;
export const VERSION: string = typeof BAI_VERSION === "string" ? BAI_VERSION : "0.1.0";
