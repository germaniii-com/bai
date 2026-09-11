import type { SessionUsage } from "@bai/shared";
import {
  contextBreakdownRows,
  contextTokensUsed,
  formatTokens,
} from "@bai/shared";
import { Modal } from "./components";

/**
 * The context-usage breakdown modal, opened from the composer's context chip.
 *
 * The header + bar show the last turn's EXACT provider-reported context
 * tokens (`used/window`, percent full). The rows below are the estimated
 * per-category composition of the prompt that produced those tokens —
 * providers only report the total, so each category is a chars/4 estimate
 * and is prefixed with `~`. Legacy snapshots / pre-first-turn sessions have
 * no breakdown; the modal says so instead of rendering empty rows.
 */
export function ContextUsageModal({
  usage,
  onClose,
}: {
  usage: SessionUsage;
  onClose: () => void;
}) {
  const used = contextTokensUsed(usage);
  const window = usage.contextWindow;
  const pct =
    window !== undefined && window > 0
      ? Math.round((used / window) * 100)
      : undefined;
  const rows = contextBreakdownRows(usage.breakdown);

  return (
    <Modal
      open
      onClose={onClose}
      title="Context Usage"
      ariaLabel="Context usage"
      size="sm"
    >
      <div className="ctx-usage">
        <div className="ctx-usage-head">
          <span className="ctx-usage-pct">
            {pct !== undefined ? `${pct}% full` : "context usage"}
          </span>
          <span className="ctx-usage-counts dim">
            {window !== undefined
              ? `~${formatTokens(used)}/${formatTokens(window)} tokens`
              : `~${formatTokens(used)} tokens`}
          </span>
        </div>
        <div
          className="ctx-bar"
          role="progressbar"
          aria-valuenow={Math.min(100, Math.max(0, pct ?? 0))}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Context window used"
        >
          <div
            className="ctx-bar-fill"
            style={{
              width: `${pct !== undefined ? Math.min(100, Math.max(0, pct)) : 0}%`,
            }}
          />
        </div>
        {rows.length > 0 ? (
          <ul className="ctx-breakdown">
            {rows.map((row) => (
              <li key={row.key} className="ctx-cat">
                <span
                  className={`ctx-swatch ctx-swatch-${row.key}`}
                  aria-hidden="true"
                />
                <span className="ctx-cat-label">{row.label}</span>
                <span className="ctx-cat-tokens">
                  {formatTokens(row.tokens)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim ctx-empty">
            Per-category breakdown appears after the first model response.
          </p>
        )}
      </div>
    </Modal>
  );
}
