import { useEffect, useMemo, useState } from "react";
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
import type {
  ThemeColors,
  SkillUsageResponse,
  UsageAnalyticsQuery,
  UsageAnalyticsResponse,
  UsageGranularity,
} from "@bai/shared";
import { useUsage } from "./use-usage";
import { Button, Card, Combobox, PageHeader, Select, type ComboboxOption } from "./components";

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

/** Facet filter options: the "All …" empty value leads, then the facet values. */
function facetOptions(values: string[], allLabel: string): ComboboxOption[] {
  return [{ value: "", label: allLabel }, ...values.map((v) => ({ value: v, label: v }))];
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

  // Skill activity (the skill_events store) — shares the window + granularity
  // with the token filters; the LLM-specific dimensions don't apply. A
  // skills.view call only happens inside a run, so any view implies LLM
  // usage exists and this card renders below the main charts.
  const [skillUsage, setSkillUsage] = useState<SkillUsageResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const from = RANGE_DAYS[range];
        const res = await client.skillUsage({
          granularity,
          ...(from !== undefined ? { from: daysAgoIso(from) } : {}),
        });
        if (!cancelled) setSkillUsage(res);
      } catch {
        if (!cancelled) setSkillUsage(null); // advisory — the card shows its empty stance
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, granularity, range]);

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
      <div className="analytics">
        <PageHeader title="Analytics" />
        <p className="dim">{refreshing ? "loading…" : "No usage data available."}</p>
      </div>
    );
  }

  if (usage.kpis.requests === 0) {
    return (
      <div className="analytics">
        <PageHeader title="Analytics" />
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
    <div className="analytics">
      <PageHeader
        title={
          <>
            Analytics
            {refreshing && <span className="dim"> · refreshing…</span>}
          </>
        }
      />

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
        <Select
          value={range}
          onChange={(v) => setRange(v as Range)}
          ariaLabel="Date range"
          options={[
            { value: "7d", label: "Last 7 days" },
            { value: "30d", label: "Last 30 days" },
            { value: "90d", label: "Last 90 days" },
            { value: "all", label: "All time" },
          ]}
        />
        <Combobox
          value={agent}
          onChange={setAgent}
          ariaLabel="Agent filter"
          options={facetOptions(usage.facets.agents, "All agents")}
          placeholder="All agents"
          emptyText="No agents in this window."
        />
        <Combobox
          value={workspace}
          onChange={setWorkspace}
          ariaLabel="Workspace filter"
          options={facetOptions(usage.facets.workspaces, "All workspaces")}
          placeholder="All workspaces"
          emptyText="No workspaces in this window."
        />
        <Combobox
          value={provider}
          onChange={setProvider}
          ariaLabel="Provider filter"
          options={facetOptions(usage.facets.providers, "All providers")}
          placeholder="All providers"
          emptyText="No providers in this window."
        />
        <Combobox
          value={account}
          onChange={setAccount}
          ariaLabel="Account filter"
          options={facetOptions(usage.facets.accounts, "All accounts")}
          placeholder="All accounts"
          emptyText="No accounts in this window."
        />
        <Combobox
          value={model}
          onChange={setModel}
          ariaLabel="Model filter"
          options={facetOptions(usage.facets.models, "All models")}
          placeholder="All models"
          emptyText="No models in this window."
        />
        <Select
          value={kind}
          onChange={setKind}
          ariaLabel="Call kind filter"
          options={[
            { value: "", label: "All calls" },
            { value: "run", label: "Runs only" },
            { value: "title", label: "Titles only" },
            { value: "compaction", label: "Compactions only" },
          ]}
        />
        <Button variant="primary" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          Refresh
        </Button>
      </div>

      {/* --- KPI cards --- */}
      <div className="kpi-grid">
        {kpis.map((k) => (
          <Card key={k.label} className="kpi-card">
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value">{k.value}</span>
          </Card>
        ))}
      </div>

      {/* --- usage by model: table + stacked bars (hover: $ and tokens/day) --- */}
      <Card className="chart-card">
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
      </Card>

      {/* --- request volume by model: shaded lines --- */}
      <Card className="chart-card">
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
      </Card>

      {/* --- token breakdown: prompt / reasoning / completion --- */}
      <Card className="chart-card">
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
      </Card>

      {/* --- prompt token caching: cached vs uncached --- */}
      <Card className="chart-card">
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
      </Card>

      {/* --- errors: failed vs successful calls per bucket --- */}
      <Card className="chart-card">
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
      </Card>

      {/* --- skill activity: skills.view calls (skill_events store) --- */}
      <Card className="chart-card">
        <h3>Skill activity</h3>
        {skillUsage === null ? (
          <p className="dim">No skill activity data.</p>
        ) : skillUsage.kpis.views === 0 ? (
          <p className="dim empty">No skill views recorded yet — agents load skills via skills.view.</p>
        ) : (
          <>
            <p className="dim">
              {fmtInt(skillUsage.kpis.views)} view{skillUsage.kpis.views === 1 ? "" : "s"} ·{" "}
              {fmtInt(skillUsage.kpis.errors)} failed · {fmtInt(skillUsage.kpis.sessions)} session
              {skillUsage.kpis.sessions === 1 ? "" : "s"}
            </p>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={skillUsage.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
                        text: `${fmtInt(Number(entry.value ?? 0))} views`,
                      }))}
                    />
                  )}
                />
                <Bar dataKey="views" name="Views" fill={themeColors.secondary} />
              </BarChart>
            </ResponsiveContainer>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Views</th>
                  <th>Sessions</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {skillUsage.bySkill.map((s) => (
                  <tr key={s.skill}>
                    <td>{s.skill}</td>
                    <td>{fmtInt(s.views)}</td>
                    <td>{fmtInt(s.sessions)}</td>
                    <td>{s.lastUsedAt !== undefined ? new Date(s.lastUsedAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </div>
  );
}
