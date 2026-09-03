import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { PermissionRequest } from "@bai/shared";

/**
 * Permission ask modal (Allow once / Allow always / Reject). Mirrors the
 * TUI's permission dialog: file asks render the computed diff; reject
 * reveals an optional feedback textarea — the message rides the denial
 * back to the model (opencode's CorrectedError). Mounted by App while a
 * pending ask exists for the active session; first reply wins across
 * devices, and a losing device's modal clears via permission.replied.
 */
export function PermissionModal({
  client,
  request,
  context,
  onDone,
}: {
  client: BaiClient;
  request: PermissionRequest;
  /** Optional origin line, e.g. "subagent @plan" for a child session's ask. */
  context?: string;
  onDone: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const reply = async (status: "approved" | "rejected", scope: "once" | "always", feedback?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await client.replyPermission(request.id as string, {
        status,
        scope,
        ...(feedback !== undefined ? { message: feedback } : {}),
      });
    } catch {
      // The ask stays visible on failure (server unreachable) — retryable.
      setBusy(false);
      return;
    }
    onDone();
  };

  // Esc: step back out of the message stage, never auto-answer the ask.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && rejecting && !busy) {
        setRejecting(false);
        setMessage("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rejecting, busy]);

  const detail = request.detail;

  return (
    <div className="modal-overlay" role="presentation">
      <div
        className="perm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Permission requested"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="model-modal-head">
          <strong>Permission requested</strong>
        </div>
        <div className="perm-body">
          {context !== undefined && <p className="perm-context dim">{context}</p>}
          <p className="perm-tool">
            tool: <strong>{request.tool}</strong>
          </p>
          {detail?.summary !== undefined && <p className="perm-summary">{detail.summary}</p>}
          {detail?.diff !== undefined && (
            <pre className="perm-diff">
              {detail.diff.split("\n").map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith("+++") || line.startsWith("---")
                      ? "diff-hunk"
                      : line.startsWith("@@")
                        ? "diff-hunk"
                        : line.startsWith("+")
                          ? "diff-add"
                          : line.startsWith("-")
                            ? "diff-del"
                            : "diff-ctx"
                  }
                >
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
          {rejecting ? (
            <div className="perm-reject">
              <label className="dim" htmlFor="perm-reject-msg">
                Why reject? (optional — the model sees this message)
              </label>
              <textarea
                id="perm-reject-msg"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="e.g. wrong file, use the other module…"
                rows={3}
                autoFocus
              />
              <div className="perm-actions">
                <button type="button" className="perm-danger" disabled={busy} onClick={() => void reply("rejected", "once", message.trim().length > 0 ? message.trim() : undefined)}>
                  Reject
                </button>
                <button type="button" className="perm-ghost" disabled={busy} onClick={() => setRejecting(false)}>
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="perm-actions">
              <button type="button" className="perm-primary" disabled={busy} onClick={() => void reply("approved", "once")}>
                Allow once
              </button>
              <button type="button" className="perm-allow-always" disabled={busy} onClick={() => void reply("approved", "always")}>
                Allow always (this session)
              </button>
              <button type="button" className="perm-danger" disabled={busy} onClick={() => setRejecting(true)}>
                Reject…
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
