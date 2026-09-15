import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { fuzzyTagScore, normalizeTag, type MediaTagCount } from "@bai/shared";

/**
 * Freeform tag chips with autocomplete. Tags are normalized (lowercase/trim)
 * on commit; suggestions come from previously used tags (server-side). Enter
 * or comma commits, Backspace on an empty field removes the last chip.
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
  const generatedId = useId();
  const inputId = id ?? generatedId;

  const commit = (raw: string): void => {
    const tag = normalizeTag(raw);
    setDraft("");
    if (tag.length === 0 || value.includes(tag) || value.length >= maxCount) return;
    onChange([...value, tag]);
  };

  const remove = (tag: string): void => onChange(value.filter((t) => t !== tag));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft.length === 0 && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const available = suggestions.filter((s) => !value.includes(s.tag));
  const matches =
    draft.trim().length === 0
      ? available.slice(0, 8)
      : available
          .map((s) => ({ s, score: fuzzyTagScore(s.tag, draft) }))
          .filter((row) => row.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              b.s.count - a.s.count ||
              a.s.tag.localeCompare(b.s.tag),
          )
          .slice(0, 8)
          .map((row) => row.s);

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
          id={inputId}
          className="tag-input-text"
          value={draft}
          placeholder={value.length >= maxCount ? "" : placeholder}
          disabled={value.length >= maxCount}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => draft.length > 0 && commit(draft)}
          aria-label="Add a tag"
          spellCheck={false}
        />
      </div>
      {matches.length > 0 && (
        <div className="tag-suggestions" role="listbox" aria-label="Tag suggestions">
          {matches.map((s) => (
            <button
              key={s.tag}
              type="button"
              className="tag-suggestion"
              role="option"
              aria-selected={false}
              onClick={() => commit(s.tag)}
            >
              {s.tag} <span className="dim">· {s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
