import { useEffect } from "react";

/**
 * Toast notification for agents/tools mutation feedback (replaces the old
 * inline `.notice` banner at the top of the main pane). Fixed bottom-right,
 * auto-dismisses after a few seconds, click-to-dismiss, `role="status"` so
 * screen readers announce it without stealing focus.
 */

/** A toast message plus its styling kind (success by default). */
export interface Notice {
  message: string;
  kind: "success" | "error" | "info";
}

const DISMISS_MS = 4000;

export function Toast({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(onDismiss, DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  if (notice === null) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      <button
        type="button"
        className={`toast toast-${notice.kind}`}
        role="status"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        {notice.message}
      </button>
    </div>
  );
}
