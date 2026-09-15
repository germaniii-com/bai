import { escapeLike } from "./cursor";
import { q, type SqliteDb } from "./db";

export interface AssetTagCount {
  tag: string;
  count: number;
}

interface TagCountRow {
  tag: string;
  n: number;
}

/**
 * Normalized tags for generated assets (the gallery's tag index). One row per
 * (asset, tag); the source of truth for tag filtering and autocomplete.
 */
export class AssetTagsRepo {
  constructor(private db: SqliteDb) {}

  /** Insert a batch of tags for one asset (duplicates ignored). */
  insert(assetId: string, tags: readonly string[]): void {
    if (tags.length === 0) return;
    const stmt = this.db.query("INSERT OR IGNORE INTO asset_tags (asset_id, tag) VALUES (?, ?)");
    const run = this.db.transaction(() => {
      for (const tag of tags) stmt.run(assetId, tag);
    });
    run();
  }

  listForAsset(assetId: string): string[] {
    return q<{ tag: string }>(this.db, "SELECT tag FROM asset_tags WHERE asset_id = ? ORDER BY tag")
      .all(assetId)
      .map((row) => row.tag);
  }

  /** Replace an asset's tag set atomically (edited tags). */
  replace(assetId: string, tags: readonly string[]): void {
    const run = this.db.transaction(() => {
      this.db.query("DELETE FROM asset_tags WHERE asset_id = ?").run(assetId);
      const stmt = this.db.query("INSERT OR IGNORE INTO asset_tags (asset_id, tag) VALUES (?, ?)");
      for (const tag of tags) stmt.run(assetId, tag);
    });
    run();
  }

  /** All distinct tags with counts (bounded) — the fuzzy matcher's input. */
  list(limit = 1000): AssetTagCount[] {
    return q<TagCountRow>(
      this.db,
      "SELECT tag, COUNT(*) AS n FROM asset_tags GROUP BY tag ORDER BY n DESC, tag ASC LIMIT ?",
    )
      .all(Math.max(1, Math.min(Math.floor(limit), 5000)))
      .map((row) => ({ tag: row.tag, count: row.n }));
  }

  /** Distinct tags with counts, optionally prefix-filtered (autocomplete). */
  distinct(prefix?: string, limit = 50): AssetTagCount[] {
    const trimmed = prefix?.trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    if (trimmed !== undefined && trimmed.length > 0) {
      return q<TagCountRow>(
        this.db,
        "SELECT tag, COUNT(*) AS n FROM asset_tags WHERE tag LIKE ? ESCAPE '\\' GROUP BY tag ORDER BY n DESC, tag ASC LIMIT ?",
      )
        .all(`${escapeLike(trimmed)}%`, safeLimit)
        .map((row) => ({ tag: row.tag, count: row.n }));
    }
    return q<TagCountRow>(
      this.db,
      "SELECT tag, COUNT(*) AS n FROM asset_tags GROUP BY tag ORDER BY n DESC, tag ASC LIMIT ?",
    )
      .all(safeLimit)
      .map((row) => ({ tag: row.tag, count: row.n }));
  }

  deleteByAsset(assetId: string): void {
    this.db.query("DELETE FROM asset_tags WHERE asset_id = ?").run(assetId);
  }
}
