import { useEffect, useRef, useState } from "react";
import { Editor } from "@monaco-editor/react";
import { FileCode, FileText, FileVideo, Image as ImageIcon, RotateCw, X } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ThemeColors } from "@bai/shared";
import { defineBaiTheme } from "./monaco-setup";

/**
 * The Files view of the workspace section: a tab bar of opened files over a
 * read-only preview area. Text/code files render as source in a locally
 * bundled Monaco editor; images, PDFs, and videos render in their native
 * elements fed by blob URLs. Tab LIST state lives in App (tabs survive
 * Chat⇄Files switches); fetched CONTENT is cached here per tab and
 * refetched when the view remounts — files are small (server caps: 1 MB
 * text / 64 MB media), so the refetch is invisible in practice.
 *
 * The server sanitizes mimes (never text/html or text/javascript), so
 * blob URLs are safe to hand to <img>/<video>/<iframe>: html/xml/js files
 * arrive as text/plain and render as source, never as documents.
 */

/** How a file previews, decided client-side by extension (mirrors the
 * server's media map — everything non-media arrives as text/plain). */
type FileKind = "text" | "image" | "pdf" | "video";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mov", "ogv", "mkv"]);

export function fileKind(path: string): FileKind {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (VIDEO_EXT.has(ext)) return "video";
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
  md: "markdown", markdown: "markdown", mdx: "mdx",
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

/** One opened file's fetched state (content cache entry). */
type FileEntry =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; kind: "text"; text: string }
  | { status: "ok"; kind: "binary" }
  | { status: "ok"; kind: "image" | "pdf" | "video"; url: string };

export function FileView({
  client,
  root,
  openFiles,
  activeFile,
  themeColors,
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
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
}) {
  const [entries, setEntries] = useState<Map<string, FileEntry>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());
  const urlsRef = useRef<Set<string>>(new Set());
  // The Monaco theme name — defined from the palette data (themes.ts), so a
  // theme switch re-skins the live editor with no CSS-read race. The
  // initializer guarantees a defined theme before the Editor ever mounts.
  const [monacoTheme, setMonacoTheme] = useState(() => defineBaiTheme(themeColors));

  // Fetch the active file when it has no cache entry yet. Errors cache as
  // entries (retry clears them); blob URLs register for revocation.
  useEffect(() => {
    if (activeFile === null) return;
    if (entries.has(activeFile) || inflightRef.current.has(activeFile)) return;
    const path = activeFile;
    inflightRef.current.add(path);
    setEntries((prev) => new Map(prev).set(path, { status: "loading" }));
    void (async () => {
      try {
        const res = await client.readFile(root, path);
        const kind = fileKind(path);
        if (kind === "text") {
          const text = await res.text();
          // Cheap binary sniff: NUL bytes in the head mean the "text" file
          // is actually binary (e.g. .wasm) — no mojibake preview.
          const binary = text.slice(0, 1000).includes("\u0000");
          setEntries((prev) => new Map(prev).set(path, binary ? { status: "ok", kind: "binary" } : { status: "ok", kind: "text", text }));
        } else {
          const url = URL.createObjectURL(await res.blob());
          urlsRef.current.add(url);
          setEntries((prev) => new Map(prev).set(path, { status: "ok", kind, url }));
        }
      } catch (err) {
        setEntries((prev) =>
          new Map(prev).set(path, {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        inflightRef.current.delete(path);
      }
    })();
  }, [activeFile, entries, client, root]);

  // Workspace switch: drop the whole cache (App also resets the tab list).
  useEffect(() => {
    setEntries(new Map());
    inflightRef.current.clear();
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
      <div className="file-preview">
        {activeFile === null ? (
          <p className="dim empty">No file open — pick a file from the tree.</p>
        ) : entry === undefined || entry.status === "loading" ? (
          <p className="dim empty">Loading {basename(activeFile)}…</p>
        ) : entry.status === "error" ? (
          <div className="viewer-message" role="alert">
            <p>Cannot open {basename(activeFile)}: {entry.message}</p>
            <button
              type="button"
              onClick={() =>
                setEntries((prev) => {
                  const next = new Map(prev);
                  next.delete(activeFile);
                  return next;
                })
              }
            >
              <RotateCw size={12} aria-hidden="true" /> retry
            </button>
          </div>
        ) : entry.kind === "text" ? (
          <div className="file-editor">
            <Editor
              value={entry.text}
              language={monacoLanguage(activeFile)}
              theme={monacoTheme}
              loading={<p className="dim empty">Loading editor…</p>}
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
        ) : entry.kind === "binary" ? (
          <p className="dim empty">Binary file — no preview.</p>
        ) : entry.kind === "image" ? (
          <img className="file-media" src={entry.url} alt={basename(activeFile)} />
        ) : entry.kind === "pdf" ? (
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
  if (kind === "pdf") return <FileText className="tree-icon" aria-hidden="true" />;
  return <FileCode className="tree-icon" aria-hidden="true" />;
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}
