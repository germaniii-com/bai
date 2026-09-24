import { useEffect, useState } from "react";
import { Check, CircleAlert, Info } from "lucide-react";

/**
 * Toast notification for mutation feedback. Fixed bottom-right, auto-dismisses
 * after a few seconds, click-to-dismiss, `role="status"` so screen readers
 * announce it without stealing focus. Enter/exit animated (the last notice
 * stays mounted through the exit), with a per-kind icon.
 */

/** A toast message plus its styling kind (success by default). */
export interface Notice {
  message: string;
  kind: "success" | "error" | "info";
}

const DISMISS_MS = 4000;
/** Matches --duration-fast; the exit animation length. */
const ANIM_MS = 120;

export function Toast({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  // Keep the last notice mounted through the exit animation so it can fade.
  const [shown, setShown] = useState<Notice | null>(notice);
  const [exiting, setExiting] = useState(false);

  // Adopt a new notice (and cancel any in-flight exit).
  useEffect(() => {
    if (notice === null) return;
    setShown(notice);
    setExiting(false);
  }, [notice]);

  // Auto-dismiss.
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(onDismiss, DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  // When the notice clears, play the exit, then unmount.
  useEffect(() => {
    if (notice !== null || shown === null) return;
    setExiting(true);
    const timer = setTimeout(() => {
      setShown(null);
      setExiting(false);
    }, ANIM_MS);
    return () => clearTimeout(timer);
  }, [notice, shown]);

  if (shown === null) return null;
  const Icon = shown.kind === "success" ? Check : shown.kind === "error" ? CircleAlert : Info;
  return (
    <div className="toast-stack" aria-live="polite">
      <button
        type="button"
        className={`toast toast-${shown.kind}${exiting ? " exiting" : ""}`}
        role="status"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <span className="toast-icon" aria-hidden="true">
          <Icon size={15} />
        </span>
        <span>{shown.message}</span>
      </button>
    </div>
  );
}
