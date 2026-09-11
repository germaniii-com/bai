import type { SessionUsage } from "@bai/shared";
import {
  contextBreakdownRows,
  contextTokensUsed,
  formatCost,
  formatTokens,
} from "@bai/shared";
import { Modal } from "./components";

/**
 * The context-usage breakdown modal, opened from the composer's context chip.
 *
 * The header + bar show the last turn's EXACT provider-reported context
 * tokens (`used/window`, percent full), plus the cumulative estimated session
 * cost. The bar is stacked in the category colors: the exact used fraction is
 * subdivided by each category's estimated token share (so it matches the
 * legend below), and the remainder is the free window. The rows below are the
 * estimated per-category composition — providers only report the total, so
 * each category is a chars/4 estimate and is prefixed with `~`. Legacy
 * snapshots / pre-first-turn sessions have no breakdown; the modal says so
 * instead of rendering empty rows.
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
  const costUsd =
    usage.costUsd !== undefined && usage.costUsd > 0 ? usage.costUsd : undefined;

  // The bar's fill is the exact % full; its segments are that fill split by
  // category share. Estimates don't sum to the provider total, so normalize
  // against the category sum (not the token total) and scale to the fill.
  // With no window there is no "% full" — show the composition at full width.
  const clampedPct = pct !== undefined ? Math.min(100, Math.max(0, pct)) : 0;
  const stackPct = pct !== undefined ? clampedPct : 100;
  const breakdownTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
  const segments =
    breakdownTotal > 0
      ? rows.map((row) => ({
          key: row.key,
          width: (row.tokens / breakdownTotal) * stackPct,
        }))
      : [];

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
          aria-valuenow={clampedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Context window used"
        >
          {segments.length > 0 ? (
            <>
              {segments.map((seg) => (
                <span
                  key={seg.key}
                  className={`ctx-bar-seg ctx-swatch-${seg.key}`}
                  style={{ width: `${seg.width}%` }}
                />
              ))}
              {/* Free window — the unfilled tail of the track. */}
              <span className="ctx-bar-free" />
            </>
          ) : (
            <div className="ctx-bar-fill" style={{ width: `${clampedPct}%` }} />
          )}
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
        {costUsd !== undefined && (
          // Cumulative estimate over every recorded call — the same figure
          // the TUI tracker shows after the percentage.
          <div className="ctx-cost">
            <span className="ctx-cost-label">session cost (est.)</span>
            <span className="ctx-cost-value">{formatCost(costUsd)}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
