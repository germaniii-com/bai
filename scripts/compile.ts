/**
 * Compile the bai single executable.
 *
 *   bun run scripts/compile.ts              → dist/bai             (host)
 *   BAI_VERSION=1.2.3 bun run scripts/compile.ts
 *   bun run scripts/compile.ts --release    → dist/bai-<os>-<arch> (all targets)
 *
 * - BAI_VERSION is stamped into the binary via `define` (the analog of Go's
 *   `-ldflags -X …version=$(VERSION)`); defaults to "dev".
 * - The built web SPA (packages/web/dist) is embedded via compile assets
 *   when present — the analog of `//go:embed all:dist` — and served by
 *   `@bai/api` through the same relative path at runtime.
 * - react-devtools-core is stubbed: ink's reconciler calls
 *   `import.meta.resolve("react-devtools-core")` at module init to detect
 *   devtools availability; the package is dev-only and never loaded by bai.
 */
import { existsSync } from "node:fs";
import type { BunPlugin } from "bun";

const version = process.env.BAI_VERSION ?? "dev";
const release = process.argv.includes("--release");

const entrypoint = new URL("../packages/cli/src/index.ts", import.meta.url).pathname;
const distDir = new URL("../dist/", import.meta.url).pathname;
const webDist = new URL("../packages/web/dist", import.meta.url).pathname;

/** All 8 cross-compile targets (bun build --compile matrix). */
const RELEASE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-windows-x64",
  "bun-windows-arm64",
] as const;

const stubPlugin: BunPlugin = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

async function compileOne(target: string | undefined): Promise<void> {
  // Embed the built SPA under its original relative path so
  // paths.webDistDir() (import.meta.dir + ../../web/dist) resolves unchanged
  // inside the binary — mirroring go:embed all:dist.
  const hasWebAssets = existsSync(`${webDist}/index.html`);
  const outfile =
    target === undefined
      ? `${distDir}bai`
      : `${distDir}bai-${target.replace(/^bun-/, "")}${target.includes("windows") ? ".exe" : ""}`;

  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    define: { BAI_VERSION: JSON.stringify(version) },
    plugins: [stubPlugin],
    // Faster startup: minify shrinks the source the binary must parse on
    // every launch (the bundle carries React/Ink/Hono/SDKs — several MB of
    // JS). NOTE: `bytecode: true` was tried and REJECTED — on bun 1.3.14 it
    // fails to bundle yoga-layout 3.2.1 (top-level await module):
    // "Expected ';' but found ')'" at yoga-layout/dist/src/index.js:13.
    // Revisit when the runtime is upgraded.
    minify: true,
    compile: {
      ...(target !== undefined ? { target } : {}),
      outfile,
      ...(hasWebAssets ? { assets: ["packages/web/dist"] } : {}),
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exitCode = 1;
    return;
  }
  console.log(`compiled ${version} → ${outfile.replace(process.cwd() + "/", "")}`);
}

if (release) {
  for (const target of RELEASE_TARGETS) {
    await compileOne(target);
  }
} else {
  await compileOne(undefined);
}
