import { useId, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { fuzzyTagScore, normalizeTag, type MediaTagCount } from "@bai/shared";

/** How many suggestions the autocomplete shows at most. */
const MAX_SUGGESTIONS = 10;

/**
 * Freeform tag chips with a fuzzy autocomplete over the available tags.
 * Suggestions open on focus and filter as you type — every whitespace token
 * must match (prefix / substring / subsequence), ranked by tightness then
 * usage count. Clicking or Enter-selecting one APPENDS it to the chips;
 * Enter with nothing highlighted commits the typed text; Backspace on an
 * empty field removes the last chip.
 */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "Add tag…",
  maxCount = 10,
  id,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: MediaTagCount[];
  placeholder?: string;
  maxCount?: number;
  id?: string;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const inputId = id ?? generatedId;

  const full = value.length >= maxCount;
  const available = suggestions.filter((s) => !value.includes(s.tag));
  const query = draft.trim();
  const matches = (
    query.length === 0
      ? available
      : available
          .map((s) => ({ s, score: fuzzyTagScore(s.tag, draft) }))
          .filter((row) => row.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.s.count - a.s.count ||
              a.s.tag.localeCompare(b.s.tag),
          )
          .map((row) => row.s)
  ).slice(0, MAX_SUGGESTIONS);

  const commit = (raw: string): void => {
    const tag = normalizeTag(raw);
    setDraft("");
    setActive(0);
    if (tag.length === 0 || value.includes(tag) || value.length >= maxCount) return;
    onChange([...value, tag]);
  };

  const remove = (tag: string): void => onChange(value.filter((t) => t !== tag));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const picked = open ? matches[active] : undefined;
      commit(picked !== undefined ? picked.tag : draft);
      return;
    }
    // Tab commits the typed tag but keeps its default behaviour (focus moves
    // on) — no autocomplete required for a plain chip input.
    if (e.key === "Tab" && draft.trim().length > 0) {
      commit(draft);
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "Backspace" && draft.length === 0 && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="tag-input">
      <div className="tag-input-field">
        {value.map((tag) => (
          <span className="tag-chip" key={tag}>
            {tag}
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove tag ${tag}`}
              onClick={() => remove(tag)}
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          className="tag-input-text"
          value={draft}
          placeholder={full ? "" : placeholder}
          disabled={full}
          onChange={(e) => {
            setDraft(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (draft.length > 0) commit(draft);
          }}
          aria-label="Add a tag"
          aria-autocomplete="list"
          aria-expanded={open && matches.length > 0}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
        />
      </div>
      {open && !full && matches.length > 0 && (
        <div className="tag-input-pop" role="listbox" aria-label="Tag suggestions">
          {matches.map((s, i) => (
            <button
              key={s.tag}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? "tag-input-option active" : "tag-input-option"}
              // Keep the input focused so the click never races the blur.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={(e) => {
                // Don't let the surrounding Field <label>/form swallow the pick.
                e.preventDefault();
                e.stopPropagation();
                commit(s.tag);
                inputRef.current?.focus();
              }}
            >
              <span className="tag-chip">{s.tag}</span>
              <span className="dim">{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
