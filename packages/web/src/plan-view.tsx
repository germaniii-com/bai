import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { BaiClient } from "@bai/api/client";
import type { ThemeColors } from "@bai/shared";
import { defineBaiTheme } from "./monaco-setup";

/** Debounce before an edit is persisted (ms) — mirrors the Notes panel. */
const SAVE_DEBOUNCE_MS = 800;
/** How long the "saved" indicator lingers before fading back to idle (ms). */
const SAVED_LINGER_MS = 1500;

/** The autosave status surfaced on the plan's file tab. */
export type PlanSaveStatus = "idle" | "dirty" | "saving" | "saved";

/**
 * The editable plan editor shown in the workspace Files view when a plan tab
 * is active. Edits AUTO-SAVE (debounced, like the Notes panel) through
 * `putPlan`; there is no header/button row — the open tab identifies the plan
 * and deletion lives on the Plans panel's trash. The save status is reported
 * up via `onStatusChange` so the TAB can show it. Content is fetched per open
 * plan; a `plans.updated` revision (the agent rewrote it) is adopted only
 * while the editor is clean. The component is keyed by plan name, so
 * switching plans flushes a pending edit on unmount.
 */
export function PlanView({
  client,
  sessionId,
  name,
  revision,
  themeColors,
  onStatusChange,
}: {
  client: BaiClient;
  sessionId: string;
  name: string;
  /** Plan metadata stamp (updatedAt) — a change refetches a clean editor. */
  revision: string;
  themeColors: ThemeColors;
  /** Report autosave status to the tab strip. */
  onStatusChange?: (status: PlanSaveStatus) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [status, setStatus] = useState<PlanSaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [monacoTheme, setMonacoTheme] = useState(() => defineBaiTheme(themeColors));
  const loadedNameRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);
  const contentRef = useRef<string | null>(content);
  contentRef.current = content;
  const savedRef = useRef(savedContent);
  savedRef.current = savedContent;
  const dirtyRef = useRef(false);
  dirtyRef.current = content !== null && content !== savedContent;

  const clearSavedTimer = useCallback((): void => {
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const doc = await client.getPlan(sessionId, name);
      const next = doc?.content ?? "";
      loadedNameRef.current = name;
      contentRef.current = next;
      savedRef.current = next;
      setContent(next);
      setSavedContent(next);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, sessionId, name]);

  // Initial load / plan switch.
  useEffect(() => {
    void load();
  }, [load]);

  // External update (plans.updated): adopt only for the loaded plan, and only
  // when the editor has no unsaved edits (never clobber typing).
  useEffect(() => {
    if (loadedNameRef.current !== name || dirtyRef.current) return;
    void load();
  }, [revision, name, load]);

  useEffect(() => {
    setMonacoTheme(defineBaiTheme(themeColors));
  }, [themeColors]);

  // Surface the autosave status to the tab strip.
  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  const save = useCallback(
    async (text: string): Promise<void> => {
      setStatus("saving");
      try {
        await client.putPlan(sessionId, name, text);
        savedRef.current = text;
        setSavedContent(text);
        setStatus("saved");
        clearSavedTimer();
        savedTimerRef.current = window.setTimeout(() => {
          savedTimerRef.current = null;
          setStatus((current) => (current === "saved" ? "idle" : current));
        }, SAVED_LINGER_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("dirty");
      }
    },
    [client, sessionId, name, clearSavedTimer],
  );

  const change = (value: string): void => {
    setContent(value);
    setStatus("dirty");
    clearSavedTimer();
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void save(value);
    }, SAVE_DEBOUNCE_MS);
  };

  // Cmd/Ctrl+S forces an immediate save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (contentRef.current !== null) void save(contentRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Flush a pending edit on unmount (switching plans/sessions) so an edit
  // made within the debounce window is never lost. The mount-time closures
  // target this plan, which is exactly the one being saved.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        if (contentRef.current !== null && contentRef.current !== savedRef.current) {
          void saveRef.current(contentRef.current);
        }
      }
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, []);

  return (
    <section className="plan-view" aria-label={`Plan ${name}`}>
      {error !== null && <div className="error plan-error">{error}</div>}
      <div className="plan-editor">
        {content === null ? (
          <p className="dim empty">Loading plan…</p>
        ) : (
          <Editor
            value={content}
            language="markdown"
            theme={monacoTheme}
            loading={<p className="dim empty">Loading editor…</p>}
            onMount={(editor) => {
              requestAnimationFrame(() => {
                try {
                  editor.layout();
                } catch {
                  // disposed mid-flight — the next mount measures itself
                }
              });
            }}
            onChange={(value) => change(value ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "on",
              stickyScroll: { enabled: false },
              padding: { top: 10, bottom: 10 },
            }}
          />
        )}
      </div>
    </section>
  );
}
