import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, StickyNote } from "lucide-react";

/** Debounce before an edit is persisted (ms). */
const SAVE_DEBOUNCE_MS = 800;

/**
 * The workspace right-rail Notes panel: the active session's `notes.md`
 * scratchpad, edited inline. Edits are debounced and autosaved; a remote
 * `notes.updated` (the agent, or another device) is adopted only while the
 * local editor is clean, so it never clobbers in-progress typing. Collapsible.
 *
 * The caller should key this component by session id so switching sessions
 * remounts it with the new note.
 */
export function NotesPanel({
  notes,
  onSave,
  disabled = false,
}: {
  notes: string;
  /** Persist the whole note; resolves when the server stored it. */
  onSave: (content: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [value, setValue] = useState(notes);
  const [status, setStatus] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const valueRef = useRef(value);
  valueRef.current = value;
  const savedRef = useRef(notes);
  const timerRef = useRef<number | null>(null);

  // Adopt a remote note only when the editor is clean (value === last saved).
  // A dirty editor keeps the user's text; their pending save wins.
  useEffect(() => {
    if (valueRef.current !== savedRef.current) return;
    savedRef.current = notes;
    valueRef.current = notes;
    setValue(notes);
  }, [notes]);

  const save = useCallback(
    async (text: string): Promise<void> => {
      setStatus("saving");
      try {
        await onSave(text);
        savedRef.current = text;
        setStatus("saved");
      } catch {
        setStatus("dirty");
      }
    },
    [onSave],
  );

  const onChange = (text: string): void => {
    setValue(text);
    setStatus("dirty");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void save(text);
    }, SAVE_DEBOUNCE_MS);
  };

  // Persist a pending edit when the panel unmounts (session switch, panel
  // keyed by session id) — otherwise an edit made within the debounce window
  // would be lost. The mount-time `save`/`onSave` closures target this
  // session, which is exactly the one being saved.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (valueRef.current !== savedRef.current) void saveRef.current(valueRef.current);
    };
  }, []);

  const label = status === "saving" ? "Saving…" : status === "dirty" ? "Unsaved" : status === "saved" ? "Saved" : "";

  return (
    <aside className="todos-panel notes-panel" role="region" aria-label="Session notes">
      <button
        type="button"
        className="todos-head"
        aria-expanded={!collapsed}
        aria-controls="notes-body"
        onClick={() => setCollapsed((c) => !c)}
      >
        <StickyNote size={14} aria-hidden="true" />
        <span>Notes</span>
        {label.length > 0 && <span className="todos-count notes-status">{label}</span>}
        <span className="todos-chevron" aria-hidden="true">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {!collapsed && (
        <div id="notes-body" className="notes-body">
          <textarea
            className="notes-textarea"
            value={value}
            disabled={disabled}
            placeholder="Session notes…"
            aria-label="Session notes"
            spellCheck
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )}
    </aside>
  );
}
