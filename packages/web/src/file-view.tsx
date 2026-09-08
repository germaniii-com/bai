import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import { FileCode, FileText, FileVideo, Image as ImageIcon, RotateCw, X } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ThemeColors } from "@bai/shared";
import { defineBaiTheme } from "./monaco-setup";
import { Markdown } from "./markdown";
import { Button } from "./components";

/**
 * The Files view of the workspace section: a tab bar of opened files over a
 * read-only preview area. Text/code files render as source in a locally
 * bundled Monaco editor; markdown files offer a Preview ⇄ Raw toggle
 * (rendered via the shared Markdown component ⇄ source); images, PDFs, and
 * videos render in their native elements fed by blob URLs — PDFs ride the
 * browser's built-in PDF viewer (the blob's application/pdf MIME engages
 * it). Tab LIST state lives in App (tabs survive Chat⇄Files switches);
 * fetched CONTENT is cached here per tab and refetched when the view
 * remounts — files are small (server caps: 1 MB text / 64 MB media), so the
 * refetch is invisible in practice.
 *
 * The server sanitizes mimes (never text/html or text/javascript), so
 * blob URLs are safe to hand to <img>/<video>/<iframe>: html/xml/js files
 * arrive as text/plain and render as source, never as documents.
 */

/** How a file previews, decided client-side by extension (mirrors the
 * server's media map — everything non-media arrives as text/plain).
 * Markdown is a text file with a rendered Preview mode. */
type FileKind = "text" | "markdown" | "image" | "pdf" | "video";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "ogv", "mkv"]);
/** Every markdown-family extension the preview renders (md, mdx, mmd, …). */
const MARKDOWN_EXT = new Set([
  "md", "mdx", "mmd", "markdown", "mdown", "mkdn", "mkd", "mdwn",
  "mdtxt", "mdtext", "rmd", "litmd",
]);

export function fileKind(path: string): FileKind {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (VIDEO_EXT.has(ext)) return "video";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  return "text";
}

/** Extension → Monaco language id (Monaco's bundled basic-languages). */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html",
  xml: "xml", svg: "xml", xsl: "xml",
  md: "markdown", markdown: "markdown", mdx: "markdown", mmd: "markdown",
  mdown: "markdown", mkdn: "markdown", mkd: "markdown", mdwn: "markdown",
  mdtxt: "markdown", mdtext: "markdown", rmd: "markdown", litmd: "markdown",
  py: "python", pyi: "python",
  rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", swift: "swift", dart: "dart", lua: "lua",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", makefile: "shell",
};

function monacoLanguage(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

/** One opened file's fetched state (content cache entry). `gen` stamps the
 * cache generation the content was fetched at — entries older than the
 * current generation are stale (agent/revert changed files since). */
type FileEntry =
  | { status: "loading" }
  | { status: "error"; message: string; gen: number }
  | { status: "ok"; kind: "text"; text: string; gen: number }
  | { status: "ok"; kind: "binary"; gen: number }
  | { status: "ok"; kind: "image" | "pdf" | "video"; url: string; gen: number };

/** A fetched entry before the generation stamp is applied. */
type FetchedEntry =
  | { status: "ok"; kind: "text"; text: string }
  | { status: "ok"; kind: "binary" }
  | { status: "ok"; kind: "image" | "pdf" | "video"; url: string };

export function FileView({
  client,
  root,
  openFiles,
  activeFile,
  themeColors,
  changedFiles,
  fsRevision,
  onFileSeen,
  onSelectTab,
  onCloseTab,
}: {
  client: BaiClient;
  /** The workspace root — file fetches are workspace-scoped. */
  root: string;
  /** Open tabs, in open order (App-owned; survives view switches). */
  openFiles: string[];
  /** The tab whose content shows below. */
  activeFile: string | null;
  /** Active palette (themes.ts ThemeColors) — the editor re-skins on change. */
  themeColors: ThemeColors;
  /** Open tabs with unseen agent edits (change dots). */
  changedFiles: Set<string>;
  /** Bumped whenever the agent (or a revert) changes files — drop the cache
   * so the active preview refetches and the tree re-lists. */
  fsRevision: number;
  /** The active file's fresh content landed — App clears its change dot. */
  onFileSeen: (path: string) => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Map<string, FileEntry>>(new Map());
  // Per-file markdown view mode (Preview ⇄ Raw) — preserved across tab
  // switches, defaults to Preview, reset with the cache on workspace switch.
  const [mdView, setMdView] = useState<Map<string, "preview" | "raw">>(new Map());
  const urlsRef = useRef<Set<string>>(new Set());
  // The Monaco theme name — defined from the palette data (themes.ts), so a
  // theme switch re-skins the live editor with no CSS-read race. The
  // initializer guarantees a defined theme before the Editor ever mounts.
  const [monacoTheme, setMonacoTheme] = useState(() => defineBaiTheme(themeColors));
  // Current active file at async-completion time (closures go stale).
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  // The live editor instance — in-place content swaps drive the MODEL
  // directly (the wrapper's value-prop effect proved unreliable across
  // cache-entry swaps; the model update here is deterministic).
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  // Cache generation: bumped on every revision — entries stamped with an
  // older generation are stale and refetch IN PLACE (the editor's value
  // prop updates the model; no unmount/remount, which collapses Monaco's
  // measured size). No debounce: a refetch is one small GET, and timers
  // that reset on every render starve under firehose churn.
  const fsGenRef = useRef(0);

  useEffect(() => {
    if (fsRevision > 0) {
      fsGenRef.current += 1;
    }
  }, [fsRevision]);

  // One unified content effect for the active file:
  // - no entry → first open: fetch with a loading state;
  // - stale entry (gen older than the current revision generation) →
  //   in-place refetch, no loading flash — the editor stays mounted;
  // - fresh entry → nothing.
  // A fetch that lands after a newer revision discards itself and retries
  // at the new generation (bounded), so content never lags a write.
  useEffect(() => {
    if (activeFile === null) return;
    const path = activeFile;
    const entry = entries.get(path);
    if (entry !== undefined) {
      if (entry.status === "loading") return;
      if (entry.gen >= fsGenRef.current) return; // fresh
    }
    const firstOpen = entry === undefined;
    if (firstOpen) setEntries((prev) => new Map(prev).set(path, { status: "loading" }));
    void (async () => {
      // Superseded mid-flight → retry at the newer generation (a bump storm
      // is bounded by MAX_RETRIES; the next bump re-runs this effect anyway).
      for (let attempt = 0; ; attempt++) {
        const gen = fsGenRef.current;
        try {
          const res = await client.readFile(root, path);
          const kind = fileKind(path);
          let built: FetchedEntry;
          if (kind === "text" || kind === "markdown") {
            const text = await res.text();
            // Cheap binary sniff: NUL bytes in the head mean the "text" file
            // is actually binary (e.g. .wasm) — no mojibake preview.
            const binary = text.slice(0, 1000).includes("\u0000");
            built = binary ? { status: "ok", kind: "binary" } : { status: "ok", kind: "text", text };
          } else {
            const blob = await res.blob();
            // The browser's built-in PDF viewer engages on the blob's MIME
            // type — coerce it defensively in case a downstream proxy
            // stripped the server's application/pdf.
            const typed =
              kind === "pdf" && blob.type !== "application/pdf"
                ? blob.slice(0, blob.size, "application/pdf")
                : blob;
            const url = URL.createObjectURL(typed);
            urlsRef.current.add(url);
            built = { status: "ok", kind, url };
          }
          if (gen !== fsGenRef.current && attempt < 5) continue; // superseded — refetch
          setEntries((prev) => new Map(prev).set(path, { ...built, gen } as FileEntry));
          if (built.status === "ok" && path === activeFileRef.current) onFileSeen(path);
        } catch (err) {
          if (gen !== fsGenRef.current && attempt < 5) continue;
          setEntries((prev) =>
            new Map(prev).set(path, {
              status: "error",
              message: err instanceof Error ? err.message : String(err),
              gen,
            }),
          );
        }
        return;
      }
    })();
  }, [activeFile, fsRevision, entries, client, root, onFileSeen]);

  // Workspace switch: drop the whole cache (App also resets the tab list).
  useEffect(() => {
    setEntries(new Map());
    setMdView(new Map());
  }, [root]);

  // Prune cache entries whose tab closed (blob URLs revoke via the
  // reconciliation effect below).
  useEffect(() => {
    setEntries((prev) => {
      const next = new Map<string, FileEntry>();
      let changed = false;
      for (const [path, entry] of prev) {
        if (openFiles.includes(path)) next.set(path, entry);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [openFiles]);

  // Revoke blob URLs whose entry left the cache.
  useEffect(() => {
    const live = new Set<string>();
    for (const entry of entries.values()) {
      if (entry.status === "ok" && "url" in entry) live.add(entry.url);
    }
    for (const url of [...urlsRef.current]) {
      if (!live.has(url)) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(url);
      }
    }
  }, [entries]);

  // Unmount (Chat⇄Files switch): revoke everything.
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // Theme change (built-in or custom): re-define from the new palette and
  // ride the fresh theme name through the Editor's `theme` prop.
  useEffect(() => {
    setMonacoTheme(defineBaiTheme(themeColors));
  }, [themeColors]);

  const entry = activeFile !== null ? entries.get(activeFile) : undefined;
  // Markdown files view as rendered Preview by default; the per-file choice
  // (Preview ⇄ Raw) survives tab switches.
  const mdMode =
    activeFile !== null ? (mdView.get(activeFile) ?? "preview") : "preview";
  const setMdMode = (path: string, mode: "preview" | "raw"): void => {
    setMdView((prev) => new Map(prev).set(path, mode));
  };
  const isMarkdown =
    activeFile !== null &&
    fileKind(activeFile) === "markdown" &&
    entry !== undefined &&
    entry.status === "ok" &&
    entry.kind === "text";

  // In-place content application: whenever the active entry's text changes
  // (tab switch or a live refetch), push it into the model directly.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    if (entry === undefined || entry.status !== "ok" || entry.kind !== "text") return;
    const model = editor.getModel();
    if (model === null) {
      // The editor was disposed (a loading-state pass unmounted it) and the
      // ref is stale — the next onMount re-arms it.
      editorRef.current = null;
      return;
    }
    if (model.getValue() !== entry.text) model.setValue(entry.text);
  }, [entry]);

  return (
    <section className="file-view" aria-label="File viewer">
      <div className="file-tabs" role="tablist" aria-label="Open files">
        {openFiles.map((path) => {
          const active = path === activeFile;
          return (
            <div key={path} className={active ? "file-tab active" : "file-tab"}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="file-tab-btn"
                title={path}
                onClick={() => onSelectTab(path)}
              >
                <TabIcon kind={fileKind(path)} />
                <span className="file-tab-name">{basename(path)}</span>
                {changedFiles.has(path) && <span className="file-tab-dot" aria-label="changed" />}
              </button>
              <button
                type="button"
                className="file-tab-close"
                aria-label={`Close ${basename(path)}`}
                title={`Close ${basename(path)}`}
                onClick={() => onCloseTab(path)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      {isMarkdown && activeFile !== null && (
        <div className="file-view-bar">
          <div className="pane-switch" role="tablist" aria-label="Markdown view">
            <button
              type="button"
              role="tab"
              aria-selected={mdMode === "preview"}
              className={mdMode === "preview" ? "active" : undefined}
              onClick={() => setMdMode(activeFile, "preview")}
            >
              Preview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mdMode === "raw"}
              className={mdMode === "raw" ? "active" : undefined}
              onClick={() => setMdMode(activeFile, "raw")}
            >
              Raw
            </button>
          </div>
        </div>
      )}
      <div className="file-preview">
        {activeFile === null ? (
          <p className="dim empty">No file open — pick a file from the tree.</p>
        ) : entry === undefined || entry.status === "loading" ? (
          <p className="dim empty">Loading {basename(activeFile)}…</p>
        ) : entry.status === "error" ? (
          <div className="viewer-message" role="alert">
            <p>Cannot open {basename(activeFile)}: {entry.message}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setEntries((prev) => {
                  const next = new Map(prev);
                  next.delete(activeFile);
                  return next;
                })
              }
            >
              <RotateCw size={12} aria-hidden="true" /> Retry
            </Button>
          </div>
        ) : entry.kind === "text" ? (
          isMarkdown && mdMode === "preview" ? (
            // Rendered markdown (the shared chat renderer — GFM tables,
            // task lists, fenced code with language labels).
            <div className="file-md">
              <Markdown text={entry.text} />
            </div>
          ) : (
            <div className="file-editor">
              <Editor
                value={entry.text}
                language={monacoLanguage(activeFile)}
                theme={monacoTheme}
                loading={<p className="dim empty">Loading editor…</p>}
                onMount={(editor) => {
                  editorRef.current = editor;
                  // Insurance for remounts (Chat⇄Files switches): re-measure
                  // once the flex layout has settled. The rAF can outlive the
                  // editor (a loading-state pass disposes it) — a disposed
                  // layout() must not crash the app.
                  requestAnimationFrame(() => {
                    try {
                      editor.layout();
                    } catch {
                      // disposed mid-flight — the next mount measures itself
                    }
                  });
                }}
                options={{
                  readOnly: true,
                  domReadOnly: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  wordWrap: "on",
                  stickyScroll: { enabled: false },
                  contextmenu: false,
                  padding: { top: 10, bottom: 10 },
                }}
              />
            </div>
          )
        ) : entry.kind === "binary" ? (
          <p className="dim empty">Binary file — no preview.</p>
        ) : entry.kind === "image" ? (
          <img className="file-media" src={entry.url} alt={basename(activeFile)} />
        ) : entry.kind === "pdf" ? (
          // The browser's built-in PDF viewer (the blob carries
          // application/pdf — see the fetch coercion above).
          <iframe className="file-frame" src={entry.url} title={basename(activeFile)} />
        ) : (
          <video className="file-media" src={entry.url} controls />
        )}
      </div>
    </section>
  );
}

function TabIcon({ kind }: { kind: FileKind }) {
  if (kind === "image") return <ImageIcon className="tree-icon" aria-hidden="true" />;
  if (kind === "video") return <FileVideo className="tree-icon" aria-hidden="true" />;
  if (kind === "pdf" || kind === "markdown") return <FileText className="tree-icon" aria-hidden="true" />;
  return <FileCode className="tree-icon" aria-hidden="true" />;
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}
