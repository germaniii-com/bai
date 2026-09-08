/**
 * Skill definitions — the contract between file-defined skills
 * (~/.config/bai/skills/<name>/SKILL.md) and every bai surface.
 *
 * A skill is a directory whose SKILL.md is markdown with YAML frontmatter;
 * the body is the skill's instructions (hermes-agent's progressive-disclosure
 * format). The name is the directory stem:
 *
 *   ~/.config/bai/skills/arxiv/SKILL.md
 *     ---
 *     description: Search arXiv papers by keyword, author, category, or ID.
 *     version: 1.0.0
 *     tags: [research, papers]
 *     platforms: [darwin, linux]
 *     ---
 *     # arXiv Research
 *     ...
 *
 * Optional sibling directories (`references/`, `templates/`, `scripts/`,
 * `assets/`) carry supporting files the agent can read on demand through the
 * `skills.view` tool's `path` argument (progressive disclosure).
 *
 * Runtime model (hermes parity): a compact index (name + ≤60-char
 * description) is injected into the system prompt of every agent whose
 * resolved tool set includes `skills.view`; the agent loads full content on
 * demand. Every view is recorded in the `skill_events` analytics store.
 */
import { z } from "zod";
import type { UsageGranularity } from "./usage";

/** Where a skill definition comes from. */
export type SkillSource = "file";

/** A resolved skill definition. */
export interface SkillInfo {
  /** Directory stem — canonical (frontmatter carries no name override). */
  name: string;
  description: string;
  version?: string;
  author?: string;
  /** OS gates (process.platform values); undefined = all platforms. */
  platforms?: string[];
  tags?: string[];
  /** The markdown body of SKILL.md (the skill's instructions). */
  body: string;
  source: SkillSource;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** Relative paths of supporting files (references/, templates/, scripts/, assets/). */
  linkedFiles: string[];
}

/** Frontmatter of a SKILL.md file — description is required (the index needs it). */
export const skillFrontmatterSchema = z.object({
  description: z.string().min(1).max(2000),
  version: z.string().max(20).optional(),
  author: z.string().max(200).optional(),
  platforms: z.array(z.string().min(1).max(20)).max(10).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

/** Valid skill names: directory stems — letter first, then letters/digits/-/_ . */
export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/** Supporting directories scanned for linked files (hermes SKILL_SUPPORT_DIRS). */
export const SKILL_SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const;

/** Description truncation limit in the system-prompt index (hermes SKILL_PROMPT_DESC_LIMIT). */
export const SKILL_PROMPT_DESC_LIMIT = 60;

// --- skill usage analytics (skill_events store) ---

/** GET /api/skill/usage query params — same window/bucket semantics as usage analytics. */
export interface SkillUsageQuery {
  from?: string;
  to?: string;
  granularity?: UsageGranularity;
}

/** Per-skill totals (the Skills page detail pane). */
export interface SkillUsageTotals {
  views: number;
  /** Distinct sessions that viewed the skill. */
  sessions: number;
  /** RFC3339 timestamp of the most recent view. */
  lastUsedAt?: string;
}

/** GET /api/skill/usage response — aggregates over the append-only skill_events store. */
export interface SkillUsageResponse {
  kpis: {
    views: number;
    /** Failed lookups (unknown skill, traversal guard, unreadable file). */
    errors: number;
    sessions: number;
  };
  /** Per-skill totals, sorted by views desc — the top-skills table. */
  bySkill: Array<{ skill: string; views: number; errors: number; sessions: number; lastUsedAt?: string }>;
  /** Per-bucket view counts — the activity series. */
  series: Array<{ bucket: string; views: number }>;
}
