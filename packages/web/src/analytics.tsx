import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BaiClient } from "@bai/api/client";
import type { ThemeColors, UsageAnalyticsQuery, UsageAnalyticsResponse, UsageGranularity } from "@bai/shared";
import { useUsage } from "./use-usage";

/**
 * The Analytics page (D26 data): KPI cards + four charts over the usage
 * store, filterable per agent/workspace/provider/account/model/kind with
 * day/month/year granularity. All aggregation is server-side
 * (GET /api/usage/analytics); dollars are computed at fetch time from each
 * row's frozen rate snapshot. Chart colors come from the active ThemeColors
 * (recharts SVG needs concrete values, not CSS vars).
 */

/** Stable per-model palette: the theme's six accent roles, cycled. */
function palette(colors: ThemeColors): string[] {
  return [colors.primary, colors.secondary, colors.accent, colors.success, colors.warning, colors.danger];
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return fmtInt(n);
}

function fmtPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** ISO date (UTC) N days before now — the range presets' inclusive `from`. */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

type Range = "7d" | "30d" | "90d" | "all";

const RANGE_DAYS: Record<Range, number | undefined> = { "7d": 7, "30d": 30, "90d": 90, all: undefined };

/** Recharts tooltip payload entries — loosely typed (the lib's generics are
 *  readonly/parameterized); values are coerced at the use sites. */
interface TooltipEntry {
  dataKey?: unknown;
  value?: unknown;
}

interface TooltipProps {
  active?: boolean;
  label?: unknown;
  payload?: readonly TooltipEntry[];
}

/** Shared tooltip chrome — theme-drawn card listing per-series rows. */
function ChartTooltip({
  active,
  label,
  rows,
  bg,
}: {
  active?: boolean;
  label?: unknown;
  rows: { name: string; text: string; color?: string }[];
  bg: string;
}) {
  if (active !== true || rows.length === 0) return null;
  return (
    <div className="chart-tooltip" style={{ background: bg }}>
      <div className="chart-tooltip-title">{String(label)}</div>
      {rows.map((r) => (
        <div key={r.name} className="chart-tooltip-row">
          <span className="chart-tooltip-dot" style={{ background: r.color ?? "var(--dim)" }} />
          <span className="chart-tooltip-name">{r.name}</span>
          <span className="chart-tooltip-value">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

export function AnalyticsPane({ client, themeColors }: { client: BaiClient; themeColors: ThemeColors }) {
  // Filter state — the query IS the state; changing it re-fetches server-side.
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
  const [range, setRange] = useState<Range>("30d");
  const [agent, setAgent] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [provider, setProvider] = useState("");
  const [account, setAccount] = useState("");
  const [model, setModel] = useState("");
  const [kind, setKind] = useState("");

  const query: UsageAnalyticsQuery = useMemo(() => {
    const from = RANGE_DAYS[range];
    return {
      granularity,
      ...(from !== undefined ? { from: daysAgoIso(from) } : {}),
      ...(agent !== "" ? { agent } : {}),
      ...(workspace !== "" ? { workspace } : {}),
      ...(provider !== "" ? { provider } : {}),
      ...(account !== "" ? { account } : {}),
      ...(model !== "" ? { model } : {}),
      ...(kind !== "" ? { kind: kind as UsageAnalyticsQuery["kind"] } : {}),
    };
  }, [granularity, range, agent, workspace, provider, account, model, kind]);

  const { usage, refreshing, refresh } = useUsage(client, query);

  // Model → color assignment, stable across renders (byModel is spend-sorted).
  const modelColor = useMemo(() => {
    const map = new Map<string, string>();
    const colors = palette(themeColors);
    for (const [i, row] of (usage?.byModel ?? []).entries()) {
      map.set(row.model, colors[i % colors.length] ?? colors[0] ?? "#888");
    }
    return map;
  }, [usage, themeColors]);

  if (usage === null) {
    return (
      <div className="settings">
        <h2>Analytics</h2>
        <p className="dim">{refreshing ? "loading…" : "No usage data available."}</p>
      </div>
    );
  }

  if (usage.kpis.requests === 0) {
    return (
      <div className="settings">
        <h2>Analytics</h2>
        <p className="dim empty">
          No usage recorded yet — token spend, cache rates, and per-model charts appear here once agents run.
        </p>
      </div>
    );
  }

  const kpis = [
    { label: "Total Spend", value: fmtUsd(usage.kpis.spendUsd) },
    { label: "Total Tokens", value: fmtTokens(usage.kpis.totalTokens) },
    { label: "Total Requests", value: fmtInt(usage.kpis.requests) },
    { label: "Cache Hit Rate", value: fmtPercent(usage.kpis.cacheHitRate) },
    { label: "Blended $/1M", value: fmtUsd(usage.kpis.blendedUsdPer1m) },
  ];

  // Stacked usage-by-model bars: one numeric key per model (tokens); spend
  // rides a parallel lookup for the tooltip.
  const spendLookup = new Map<string, number>();
  const usageData = usage.usageByModelSeries.map((b) => {
    const datum: Record<string, string | number> = { bucket: b.bucket };
    for (const m of b.byModel) {
      datum[m.model] = m.tokens;
      spendLookup.set(`${b.bucket}|${m.model}`, m.spendUsd);
    }
    return datum;
  });
  const volumeData = usage.requestVolume.map((b) => {
    const datum: Record<string, string | number> = { bucket: b.bucket };
    for (const m of b.byModel) datum[m.model] = m.requests;
    return datum;
  });
  const models = usage.byModel.map((m) => m.model);
  const gridColor = themeColors.border;
  const axisColor = themeColors.textMuted;

  return (
    <div className="settings">
      <h2>
        Analytics
        {refreshing && <span className="dim"> · refreshing…</span>}
      </h2>

      {/* --- filters --- */}
      <div className="analytics-filters">
        <div className="pane-switch" role="tablist" aria-label="Granularity">
          {(["day", "month", "year"] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={granularity === g}
              className={granularity === g ? "active" : undefined}
              onClick={() => setGranularity(g)}
            >
              {g[0]?.toUpperCase() + g.slice(1)}
            </button>
          ))}
        </div>
        <select value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label="Date range">
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="all">All time</option>
        </select>
        <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent filter">
          <option value="">All agents</option>
          {usage.facets.agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Workspace filter">
          <option value="">All workspaces</option>
          {usage.facets.workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider filter">
          <option value="">All providers</option>
          {usage.facets.providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account filter">
          <option value="">All accounts</option>
          {usage.facets.accounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model filter">
          <option value="">All models</option>
          {usage.facets.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Call kind filter">
          <option value="">All calls</option>
          <option value="run">Runs only</option>
          <option value="title">Titles only</option>
          <option value="compaction">Compactions only</option>
        </select>
        <button type="button" onClick={() => void refresh()} disabled={refreshing}>
          refresh
        </button>
      </div>

      {/* --- KPI cards --- */}
      <div className="kpi-grid">
        {kpis.map((k) => (
          <div key={k.label} className="kpi-card">
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.value}</span>
          </div>
        ))}
      </div>

      {/* --- usage by model: table + stacked bars (hover: $ and tokens/day) --- */}
      <div className="chart-card">
        <h3>Usage by model</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={usageData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fill: axisColor, fontSize: 11 }} />
            <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickFormatter={fmtTokens} width={48} />
            <Tooltip
              content={(props: TooltipProps) => (
                <ChartTooltip
                  {...props}
                  bg={themeColors.surfaceSecondary}
                  rows={(props.payload ?? []).map((entry) => {
                    const name = String(entry.dataKey);
                    const tokens = Number(entry.value ?? 0);
                    const spend = spendLookup.get(`${String(props.label)}|${name}`) ?? 0;
                    return {
                      name,
                      text: `${fmtTokens(tokens)} tok · ${fmtUsd(spend)}`,
                      color: modelColor.get(name),
                    };
                  })}
                />
              )}
            />
            <Legend />
            {models.map((m) => (
              <Bar key={m} dataKey={m} stackId="tokens" fill={modelColor.get(m)} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <table className="usage-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Requests</th>
              <th>Errors</th>
              <th>Input</th>
              <th>Output</th>
              <th>Reasoning</th>
              <th>Cache R/W</th>
              <th>Spend</th>
            </tr>
          </thead>
          <tbody>
            {usage.byModel.map((m) => (
              <tr key={`${m.provider}/${m.model}`}>
                <td>
                  <span className="chart-tooltip-dot" style={{ background: modelColor.get(m.model) }} /> {m.model}
                  <span className="dim"> ({m.provider})</span>
                </td>
                <td>{fmtInt(m.requests)}</td>
                <td>{m.errors > 0 ? <span className="usage-errors">{fmtInt(m.errors)}</span> : "—"}</td>
                <td>{fmtTokens(m.inputTokens)}</td>
                <td>{fmtTokens(m.outputTokens)}</td>
                <td>{m.reasoningTokens > 0 ? fmtTokens(m.reasoningTokens) : "—"}</td>
                <td>
                  {fmtTokens(m.cacheReadTokens)} / {fmtTokens(m.cacheWriteTokens)}
                </td>
                <td>{fmtUsd(m.spendUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* --- request volume by model: shaded lines --- */}
      <div className="chart-card">
        <h3>Request volume by model</h3>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={volumeData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fill: axisColor, fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fill: axisColor, fontSize: 11 }} width={36} />
            <Tooltip
              content={(props: TooltipProps) => (
                <ChartTooltip
                  {...props}
                  bg={themeColors.surfaceSecondary}
                  rows={(props.payload ?? []).map((entry) => ({
                    name: String(entry.dataKey),
                    text: `${fmtInt(Number(entry.value ?? 0))} requests`,
                    color: modelColor.get(String(entry.dataKey)),
                  }))}
                />
              )}
            />
            <Legend />
            {models.map((m) => (
              <Area
                key={m}
                type="monotone"
                dataKey={m}
                stackId="requests"
                stroke={modelColor.get(m)}
                fill={modelColor.get(m)}
                fillOpacity={0.15}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* --- token breakdown: prompt / reasoning / completion --- */}
      <div className="chart-card">
        <h3>Token breakdown</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={usage.tokenBreakdown}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fill: axisColor, fontSize: 11 }} />
            <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickFormatter={fmtTokens} width={48} />
            <Tooltip
              content={(props: TooltipProps) => (
                <ChartTooltip
                  {...props}
                  bg={themeColors.surfaceSecondary}
                  rows={(props.payload ?? []).map((entry) => ({
                    name: String(entry.dataKey),
                    text: `${fmtInt(Number(entry.value ?? 0))} tokens`,
                  }))}
                />
              )}
            />
            <Legend />
            <Bar dataKey="prompt" name="Prompt" stackId="tokens" fill={themeColors.primary} />
            <Bar dataKey="reasoning" name="Reasoning" stackId="tokens" fill={themeColors.warning} />
            <Bar dataKey="completion" name="Completion" stackId="tokens" fill={themeColors.success} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* --- prompt token caching: cached vs uncached --- */}
      <div className="chart-card">
        <h3>Prompt token caching</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={usage.cacheSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fill: axisColor, fontSize: 11 }} />
            <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickFormatter={fmtTokens} width={48} />
            <Tooltip
              content={(props: TooltipProps) => (
                <ChartTooltip
                  {...props}
                  bg={themeColors.surfaceSecondary}
                  rows={(props.payload ?? []).map((entry) => ({
                    name: String(entry.dataKey),
                    text: `${fmtInt(Number(entry.value ?? 0))} tokens`,
                  }))}
                />
              )}
            />
            <Legend />
            <Bar dataKey="cached" name="Cached" stackId="cache" fill={themeColors.success} />
            <Bar dataKey="uncached" name="Uncached" stackId="cache" fill={themeColors.warning} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* --- errors: failed vs successful calls per bucket --- */}
      <div className="chart-card">
        <h3>Errors</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={usage.errorSeries.map((b) => ({
              bucket: b.bucket,
              errors: b.errors,
              successful: b.requests - b.errors,
            }))}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fill: axisColor, fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fill: axisColor, fontSize: 11 }} width={36} />
            <Tooltip
              content={(props: TooltipProps) => (
                <ChartTooltip
                  {...props}
                  bg={themeColors.surfaceSecondary}
                  rows={(props.payload ?? []).map((entry) => ({
                    name: String(entry.dataKey),
                    text: `${fmtInt(Number(entry.value ?? 0))} calls`,
                  }))}
                />
              )}
            />
            <Legend />
            <Bar dataKey="successful" name="Successful" stackId="calls" fill={themeColors.success} />
            <Bar dataKey="errors" name="Errors" stackId="calls" fill={themeColors.danger} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
