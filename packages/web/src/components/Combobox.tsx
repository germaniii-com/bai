import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, X } from "lucide-react";

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}

type BaseProps = {
  options: ComboboxOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Empty-list message (after filtering). */
  emptyText?: string;
  /** Allow entering values not in the list (Enter commits the typed text). */
  creatable?: boolean;
  className?: string;
};

export type ComboboxProps = BaseProps &
  (
    | {
        multiple: true;
        values: string[];
        onValuesChange: (values: string[]) => void;
      }
    | {
        multiple?: false;
        value: string | null;
        onChange: (value: string) => void;
      }
  );

type Row = { kind: "option"; option: ComboboxOption } | { kind: "create"; value: string };

/**
 * The autocomplete/combobox. Type-to-filter, full keyboard support
 * (↑/↓ move, Enter select, Esc closes the popup — and only the popup, even
 * inside a Modal), click-outside closes. Two modes:
 *
 * - single: `value`/`onChange` — one selection; the field displays the
 *   selected label when closed. With `creatable`, typed free text commits.
 * - multiple: `multiple values`/`onValuesChange` — selections render as
 *   removable chips inside the field; Backspace on an empty input removes
 *   the last chip.
 *
 * Heights come from --control-h-md (matches Button/TextInput). The popup
 * anchors to the field (full-width on phones — it can't overflow).
 */
export function Combobox(props: ComboboxProps) {
  const { options, placeholder, disabled = false, ariaLabel, emptyText = "No matches.", creatable = false, className } = props;
  const multiple = props.multiple === true;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const selectedValues = multiple ? props.values : props.value != null ? [props.value] : [];

  // Selected labels for display (single mode shows the label, not the id).
  const labelOf = (v: string): string => options.find((o) => o.value === v)?.label ?? v;

  // Type-to-filter: case-insensitive substring over label OR value. Multi
  // mode hides already-selected options (chips carry them).
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      options.filter((o) => {
        if (multiple && selectedValues.includes(o.value)) return false;
        if (q.length === 0) return true;
        return o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
      }),
    // selectedValues is derived per render; options/query drive the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, q, multiple, props.multiple === true ? props.values : props.value],
  );

  // Rows = filtered options + (creatable) an "+ add" row for unmatched text.
  const rows = useMemo<Row[]>(() => {
    const base: Row[] = filtered.map((option) => ({ kind: "option" as const, option }));
    if (creatable && q.length > 0 && !options.some((o) => o.value.toLowerCase() === q || o.label.toLowerCase() === q)) {
      base.push({ kind: "create", value: query.trim() });
    }
    return base;
  }, [filtered, creatable, q, options, query]);

  // Reset/keep the active row valid whenever the rows change.
  useEffect(() => {
    setActive((current) => (current < rows.length ? current : 0));
  }, [rows]);

  // Click-outside closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the active row visible while arrowing through the popup.
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector(".combobox-option.active")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const commit = (value: string): void => {
    if (multiple) {
      const next = props.values.includes(value) ? props.values : [...props.values, value];
      props.onValuesChange(next);
      setQuery("");
      inputRef.current?.focus();
    } else {
      props.onChange(value);
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
    }
  };

  const removeValue = (value: string): void => {
    if (!multiple) return;
    props.onValuesChange(props.values.filter((v) => v !== value));
  };

  const openPopup = (): void => {
    if (disabled) return;
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        openPopup();
        return;
      }
      setActive((i) => Math.min(i + 1, Math.max(0, rows.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      // Never submit the surrounding form from inside the combobox.
      e.preventDefault();
      const row = rows[active];
      if (open && row !== undefined) {
        commit(row.kind === "option" ? row.option.value : row.value);
      } else if (!open) {
        openPopup();
      }
      return;
    }
    if (e.key === "Escape" && open) {
      // Close only the popup — stop the bubbling Esc from closing a Modal.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery("");
      return;
    }
    if (e.key === "Backspace" && multiple && query.length === 0 && props.values.length > 0) {
      props.onValuesChange(props.values.slice(0, -1));
    }
  };

  const displayValue = open ? query : (selectedValues.length > 0 && !multiple ? labelOf(selectedValues[0] ?? "") : "");
  const singlePlaceholder = !multiple && selectedValues.length > 0 ? labelOf(selectedValues[0] ?? "") : (placeholder ?? "");

  return (
    <div ref={rootRef} className={className !== undefined ? `combobox ${className}` : "combobox"}>
      <div
        className={disabled ? "combobox-field disabled" : "combobox-field"}
        onClick={() => openPopup()}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
      >
        {multiple &&
          props.values.map((v) => (
            <span key={v} className="chip selected">
              <span className="chip-label">{labelOf(v)}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${labelOf(v)}`}
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  removeValue(v);
                }}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
        <input
          ref={inputRef}
          className="combobox-input"
          value={displayValue}
          placeholder={singlePlaceholder}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="combobox-caret" aria-hidden="true">
          <ChevronDown size={14} />
        </span>
      </div>
      {open && !disabled && (
        <div className="combobox-pop" ref={popRef} role="listbox">
          {rows.length === 0 && <p className="combobox-empty">{emptyText}</p>}
          {rows.map((row, i) =>
            row.kind === "option" ? (
              <button
                key={row.option.value}
                type="button"
                role="option"
                aria-selected={selectedValues.includes(row.option.value)}
                className={i === active ? "combobox-option active" : "combobox-option"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(row.option.value)}
              >
                <span className="li-title">{row.option.label}</span>
                {row.option.hint !== undefined && <span className="co-sub">{row.option.hint}</span>}
                {selectedValues.includes(row.option.value) && (
                  <span className="co-check" aria-hidden="true">
                    <Check size={12} />
                  </span>
                )}
              </button>
            ) : (
              <button
                key={`__create__${row.value}`}
                type="button"
                role="option"
                aria-selected={false}
                className={i === active ? "combobox-option active" : "combobox-option"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(row.value)}
              >
                <span className="li-title">+ Add “{row.value}”</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
