import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { QuestionRequest } from "@bai/shared";

/**
 * Question modal — the web answer half of the `question` tool. One block at
 * a time: radio buttons for single-select, checkboxes for multiple, plus a
 * free-text "Other" field. Submit answers in question order; Dismiss
 * rejects the whole block (the model sees the dismissal as an error result).
 */
export function QuestionModal({
  client,
  request,
  onDone,
}: {
  client: BaiClient;
  request: QuestionRequest;
  onDone: () => void;
}) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [customs, setCustoms] = useState<string[]>(() => request.questions.map(() => ""));
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      onDone();
    }
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
    <div className="modal-overlay" role="presentation">
      <div
        className="perm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Questions from the agent"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="model-modal-head">
          <strong>Questions</strong>
        </div>
        <div className="perm-body">
          {request.questions.map((q, qi) => (
            <fieldset key={qi} className="question-block">
              <legend className="question-header">{q.header}</legend>
              <p className="question-text">{q.question}</p>
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
              <input
                className="question-custom"
                placeholder="Type your own answer…"
                value={customs[qi] ?? ""}
                onChange={(e) => setCustom(qi, e.target.value)}
              />
            </fieldset>
          ))}
          <div className="perm-actions">
            <button type="button" className="perm-primary" disabled={busy} onClick={() => void submit()}>
              Submit answers
            </button>
            <button type="button" className="perm-danger" disabled={busy} onClick={() => void dismiss()}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
