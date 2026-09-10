import { useEffect, useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo, Session } from "@bai/shared";
import { ListItem, Modal } from "./components";

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
        data-tooltip={`Agent: ${current}`}
      >
        <Bot size={13} aria-hidden="true" />
        <span className="model-current">{current}</span>
        <span className="model-caret" aria-hidden="true">
          <ChevronDown size={12} />
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

/**
 * The agent picker modal, exported for capture-mode reuse (Settings →
 * General's default-agent trigger — the same pattern as ModelModal's
 * `onPick`).
 */
export function AgentModal({
  client,
  agents,
  active,
  configDefaultAgent,
  refreshAgents,
  current,
  onClose,
  onPick,
}: {
  client: BaiClient;
  agents: AgentInfo[];
  active: Session | null;
  configDefaultAgent?: string;
  /** Engagement refetch on open; optional for capture-mode callers that
   * already keep the catalog live (Settings' firehose-fed list). */
  refreshAgents?: () => Promise<void>;
  current: string;
  onClose: () => void;
  /**
   * Capture mode (Settings' default-agent picker): clicking an agent
   * resolves the selection through `onPick` instead of applying it to the
   * session/config. The caller owns what happens with the choice.
   */
  onPick?: (name: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Engagement refetch on open (ModelModal parity): every open pulls fresh
  // data; the firehose keeps it live between opens.
  useEffect(() => {
    if (refreshAgents !== undefined) void refreshAgents();
  }, [refreshAgents]);

  const apply = async (name: string): Promise<void> => {
    // Capture mode: hand the choice to the caller (no session/config write).
    if (onPick !== undefined) {
      onPick(name);
      onClose();
      return;
    }
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
    <Modal open onClose={onClose} title="Pick an agent" ariaLabel="Pick an agent" size="sm" bodyClassName="unpadded">
      <div className="agent-modal-list">
        {sorted.length === 0 && <p className="dim col-hint">No agents yet — create one under Agents.</p>}
        {sorted.map((a) => {
          const isCurrent = a.name === current;
          const isDefault = a.name === configDefaultAgent;
          const metaLine =
            a.source +
            (a.tools.length > 0 ? ` · ${a.tools.length} tool${a.tools.length === 1 ? "" : "s"}` : " · no tools") +
            (isDefault ? " · default" : "");
          return (
            <ListItem
              key={a.name}
              title={a.name}
              subtitle={
                a.description !== undefined && a.description.length > 0 ? `${metaLine} · ${a.description}` : metaLine
              }
              disabled={busy}
              onClick={() => void apply(a.name)}
              trailing={isCurrent ? <span className="li-badge accent">current</span> : undefined}
            />
          );
        })}
      </div>
      {error !== null && <div className="error" role="alert">{error}</div>}
    </Modal>
  );
}
