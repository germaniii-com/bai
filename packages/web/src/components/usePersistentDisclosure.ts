import { useState } from "react";

/**
 * An uncontrolled open/close state persisted in sessionStorage, keyed by
 * `key`. Used by the workspace right-rail accordions (Checklist/Plans/Notes)
 * so their expanded/collapsed state survives navigation and reloads within
 * the tab. Degrades to in-memory state when sessionStorage is unavailable
 * (private mode / quota).
 */
export function usePersistentDisclosure(key: string, defaultOpen = true): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      const raw = window.sessionStorage.getItem(key);
      return raw === null ? defaultOpen : raw === "1";
    } catch {
      return defaultOpen;
    }
  });
  const set = (next: boolean): void => {
    setOpen(next);
    try {
      window.sessionStorage.setItem(key, next ? "1" : "0");
    } catch {
      // sessionStorage unavailable — memory only
    }
  };
  return [open, set];
}
