import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo, Session } from "@bai/shared";

/**
 * Chat-header agent picker (TUI ctrl+a parity): a button showing the
 * effective agent; clicking it opens a modal listing agents — name,
 * description, source, tools. Clicking an agent applies it and closes:
 * session-scoped when a session is open, otherwise the global default
 * (config `agents.default`, what sessions without a selection resolve).
 * Mirrors the ModelPicker's session/default duality; the header button is
 * the feedback (config.updated / session.updated refresh the label live).
 */
export function AgentPicker({
  client,
  agents,
  active,
  configDefaultAgent,
  refreshAgents,
}: {
  client: BaiClient;
  agents: AgentInfo[];
  active: Session | null;
  /** Current config default agent (agents.default), when set. */
  configDefaultAgent?: string;
  refreshAgents: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  const meta = active?.meta as { agent?: unknown } | undefined;
  // Session-pinned agent → config default → the built-in build agent
  // (mirrors the drain's resolution tiers and the TUI header label).
  const current =
    typeof meta?.agent === "string" && meta.agent.length > 0
      ? meta.agent
      : (configDefaultAgent ?? "build");

  return (
    <>
      <button
        type="button"
        className="model-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`agent: ${current}`}
      >
        <span className="dim">agent</span>
        <span className="model-current">{current}</span>
        <span className="model-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <AgentModal
          client={client}
          agents={agents}
          active={active}
          configDefaultAgent={configDefaultAgent}
          refreshAgents={refreshAgents}
          current={current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AgentModal({
  client,
  agents,
  active,
  configDefaultAgent,
  refreshAgents,
  current,
  onClose,
}: {
  client: BaiClient;
  agents: AgentInfo[];
  active: Session | null;
  configDefaultAgent?: string;
  refreshAgents: () => Promise<void>;
  current: string;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Engagement refetch on open (ModelModal parity): every open pulls fresh
  // data; the firehose keeps it live between opens.
  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  // esc closes (backdrop click and the × button are wired in the JSX).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apply = async (name: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (active !== null) {
        await client.setSessionAgent(active.id, { agent: name });
      } else if (configDefaultAgent !== name) {
        // No-op when unchanged — skips a pointless config write + broadcast.
        await client.putConfig({ agents: { default: name } });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // build first, then file agents alphabetically (same order as the TUI
  // switcher and the Agents section nav).
  const sorted = [...agents].sort((a, b) => {
    if (a.name === "build") return -1;
    if (b.name === "build") return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="model-modal agent-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pick an agent"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="model-modal-head">
          <strong>Pick an agent</strong>
          <button type="button" className="modal-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        <div className="agent-modal-list">
          {sorted.length === 0 && <p className="dim col-hint">No agents yet — create one under Agents.</p>}
          {sorted.map((a) => {
            const isCurrent = a.name === current;
            const isDefault = a.name === configDefaultAgent;
            return (
              <button
                key={a.name}
                type="button"
                className={isCurrent ? "model-row active" : "model-row"}
                disabled={busy}
                onClick={() => void apply(a.name)}
              >
                <span className="title">{a.name}</span>
                <span className="dim">
                  {a.source}
                  {a.tools.length > 0 ? ` · ${a.tools.length} tool${a.tools.length === 1 ? "" : "s"}` : " · no tools"}
                  {isDefault ? " · default" : ""}
                </span>
                {a.description !== undefined && a.description.length > 0 && (
                  <span className="dim agent-desc">{a.description}</span>
                )}
                {isCurrent && <span className="current-badge">current</span>}
              </button>
            );
          })}
        </div>
        {error !== null && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
