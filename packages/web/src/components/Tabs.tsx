import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface TabItem {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * The shared tab/segmented control with a sliding active indicator.
 * `variant="segmented"` is the boxed [Chat | Files] look; `variant="underline"`
 * is the flush Preview|Raw look. Replaces five bespoke implementations.
 */
export function Tabs({
  tabs,
  value,
  onChange,
  ariaLabel,
  variant = "segmented",
  className,
}: {
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  variant?: "segmented" | "underline";
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const measure = (): void => {
      const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (active === null) return;
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [value, tabs, variant]);

  // Keyboard roving: ←/→ move selection.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const enabled = tabs.filter((t) => t.disabled !== true);
      const i = enabled.findIndex((t) => t.value === value);
      if (i < 0) return;
      const next = enabled[e.key === "ArrowRight" ? (i + 1) % enabled.length : (i - 1 + enabled.length) % enabled.length];
      if (next !== undefined) {
        e.preventDefault();
        onChange(next.value);
      }
    };
    list.addEventListener("keydown", onKey);
    return () => list.removeEventListener("keydown", onKey);
  }, [tabs, value, onChange]);

  return (
    <div
      ref={listRef}
      className={`tabs tabs-${variant} ${className ?? ""}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
    >
      {indicator !== null && (
        <span
          className="tabs-indicator"
          aria-hidden="true"
          style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
        />
      )}
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab.value === value}
          disabled={tab.disabled}
          onClick={() => onChange(tab.value)}
        >
          {tab.icon}
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
