import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { PermissionRequest, QuestionRequest } from "@bai/shared";
import { Button } from "./components";

/**
 * The merged, prioritized pending ask App hands to the chat pane:
 * parent permission > subagent permission > question (the modal era's
 * ordering). Rendered INLINE between the transcript and the composer —
 * no overlay, no dim; the rest of the page stays fully interactive.
 */
export type PendingAsk =
  | { kind: "permission"; request: PermissionRequest; context?: string }
  | { kind: "question"; request: QuestionRequest };

/**
 * Inline ask panel (the web half of the non-intrusive ask UX): a normal
 * layout child of the chat surface. Permission asks render tool/summary/
 * diff with Allow once / Allow always / Reject (+ optional feedback
 * textarea — the message rides the denial back to the model, opencode's
 * CorrectedError); questions render radios/checkboxes/custom per question.
 * First reply wins across devices — a loser's panel clears via the
 * replied/rejected event.
 */
export function AskPanel({
  client,
  ask,
  queued = 0,
  onDone,
}: {
  client: BaiClient;
  ask: PendingAsk;
  /** Asks waiting behind this one (queue indicator). */
  queued?: number;
  /** Pop the head ask off its queue after a reply (App applies the slice). */
  onDone: () => void;
}) {
  return ask.kind === "permission" ? (
    <PermissionAsk client={client} request={ask.request} context={ask.context} queued={queued} onDone={onDone} />
  ) : (
    <QuestionAsk client={client} request={ask.request} queued={queued} onDone={onDone} />
  );
}

/** Permission variant — mirrors the old modal's body, minus the overlay. */
function PermissionAsk({
  client,
  request,
  context,
  queued,
  onDone,
}: {
  client: BaiClient;
  request: PermissionRequest;
  context?: string;
  queued: number;
  onDone: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState("");
  // Request-scoped busy latch (mirrors the TUI's permission-prompt.tsx):
  // the id the reply was sent for, not a bare boolean. Consecutive asks —
  // what back-to-back gated tool calls (web-search/web-fetch batches)
  // produce — swap the `request` prop on this SAME mounted instance (the
  // optimistic pop and the next asked event land in one commit, no unmount
  // between), so a bare `useState(false)` latch would stay true forever and
  // dead-button the second ask. Keyed by id the latch dies with its ask;
  // a failed reply clears it (re-arm → retry).
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = busyId === (request.id as string);

  const reply = async (status: "approved" | "rejected", scope: "once" | "always", feedback?: string) => {
    if (busy) return;
    const id = request.id as string;
    setBusyId(id);
    setError(null);
    try {
      await client.replyPermission(id, {
        status,
        scope,
        ...(feedback !== undefined ? { message: feedback } : {}),
      });
    } catch {
      // The ask stays visible on failure (server unreachable) — retryable.
      setBusyId((current) => (current === id ? null : current));
      setError("The response could not be sent. Check the connection and try again.");
      return;
    }
    onDone();
  };

  // Esc steps back out of the message stage — but only when the focus is
  // inside this panel (an inline panel must not steal the composer's esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy || !rejecting) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".ask-panel") === null) return;
      setRejecting(false);
      setMessage("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rejecting, busy]);

  const detail = request.detail;

  return (
    <div className="ask-panel" role="region" aria-label="Permission requested">
      <div className="ask-head">
        <span className="ask-warn">△</span>
        <span>Permission requested</span>
        {queued > 0 && <span className="ask-queued">· {queued} more queued</span>}
      </div>
      {context !== undefined && <p className="perm-context dim">{context}</p>}
      {error !== null && <p className="error" role="alert">{error}</p>}
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
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => void reply("rejected", "once", message.trim().length > 0 ? message.trim() : undefined)}
            >
              Reject
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="perm-actions">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void reply("approved", "once")}>
            Allow once
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void reply("approved", "always")}>
            Allow always (this session)
          </Button>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </Button>
        </div>
      )}
    </div>
  );
}

/** Question variant — mirrors the old modal's body, minus the overlay. */
function QuestionAsk({
  client,
  request,
  queued,
  onDone,
}: {
  client: BaiClient;
  request: QuestionRequest;
  queued: number;
  onDone: () => void;
}) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [customs, setCustoms] = useState<string[]>(() => request.questions.map(() => ""));
  // Request-scoped busy latch (see PermissionAsk above): keyed by the
  // request id so a next question block — which can mount as a prop swap,
  // not an unmount — never inherits this block's latch.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = busyId === (request.id as string);

  const act = (fn: () => Promise<void>) => {
    if (busy) return;
    const id = request.id as string;
    setBusyId(id);
    setError(null);
    void (async () => {
      try {
        await fn();
      } catch {
        // Keep the panel on failure (server unreachable) — retryable. The
        // old unconditional finally-pop hid a still-pending block, and the
        // rejection escaped as an unhandled error.
        setBusyId((current) => (current === id ? null : current));
        setError("The response could not be sent. Check the connection and try again.");
        return;
      }
      onDone();
    })();
  };

  const submit = () =>
    act(async () => {
      // A filled custom field replaces that question's selection.
      const final = request.questions.map((_, i) => {
        const custom = customs[i]?.trim() ?? "";
        return custom.length > 0 ? [custom] : (answers[i] ?? []);
      });
      await client.replyQuestion(request.id as string, final);
    });

  const dismiss = () => act(() => client.rejectQuestion(request.id as string));

  const setSingle = (qIndex: number, label: string) =>
    setAnswers((all) => all.map((a, i) => (i === qIndex ? [label] : a)));

  const toggleMulti = (qIndex: number, label: string) =>
    setAnswers((all) =>
      all.map((a, i) => {
        if (i !== qIndex) return a;
        return a.includes(label) ? a.filter((l) => l !== label) : [...a, label];
      }),
    );

  const setCustom = (qIndex: number, value: string) =>
    setCustoms((all) => all.map((c, i) => (i === qIndex ? value : c)));

  return (
    <div className="ask-panel question" role="region" aria-label="Questions from the agent">
      <div className="ask-head">
        <span className="ask-warn">△</span>
        <span>Questions</span>
        {queued > 0 && <span className="ask-queued">{queued} more queued</span>}
      </div>
      {request.questions.map((q, qi) => (
        <fieldset key={qi} className="question-block">
          <legend className="question-header">{q.header}</legend>
          <p className="question-text">
            {q.question}
            {q.multiple === true && <span className="dim"> (select all that apply)</span>}
          </p>
          {q.options.map((opt) => (
            <label key={opt.label} className="question-option">
              <input
                type={q.multiple === true ? "checkbox" : "radio"}
                name={`q-${request.id}-${qi}`}
                checked={(answers[qi] ?? []).includes(opt.label)}
                onChange={() =>
                  q.multiple === true ? toggleMulti(qi, opt.label) : setSingle(qi, opt.label)
                }
              />
              <span>
                <strong>{opt.label}</strong>
                <span className="dim"> — {opt.description}</span>
              </span>
            </label>
          ))}
          <label className="question-option">
            <input
              type={q.multiple === true ? "checkbox" : "radio"}
              name={`q-${request.id}-${qi}`}
              checked={(customs[qi] ?? "").trim().length > 0}
              onChange={() => setCustom(qi, "")}
            />
            <span>Other…</span>
          </label>
          <label className="question-custom-label" htmlFor={`question-custom-${request.id}-${qi}`}>
            Your answer
          </label>
          <input
            id={`question-custom-${request.id}-${qi}`}
            className="question-custom"
            placeholder="Type your own answer…"
            value={customs[qi] ?? ""}
            onChange={(e) => setCustom(qi, e.target.value)}
          />
        </fieldset>
      ))}
      {error !== null && <p className="error" role="alert">{error}</p>}
      <div className="perm-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
          Submit answers
        </Button>
        <Button variant="danger" size="sm" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
