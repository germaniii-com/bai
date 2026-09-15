import { useRef, type KeyboardEvent, type ReactNode } from "react";

/**
 * A hidden `<input type="file">` plus its trigger button — the only sanctioned
 * way to pick local files. The trigger is a real button (accessible name via
 * `label`), so screens never render a raw file input or button just to open
 * the picker.
 */
export function FileInput({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  label,
  className = "file-input",
  children,
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Accessible name for the trigger. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);

  const open = (): void => {
    if (!disabled) ref.current?.click();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };

  return (
    <>
      <input
        ref={ref}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <button
        type="button"
        className={className}
        aria-label={label}
        disabled={disabled}
        onClick={open}
        onKeyDown={onKeyDown}
      >
        {children}
      </button>
    </>
  );
}
