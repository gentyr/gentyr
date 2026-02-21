/**
 * Product Manager reader — reads PMF analysis status from .claude/state/product-manager.db
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Public interfaces
// ============================================================================

export interface ProductManagerSectionInfo {
  number: number;
  title: string;
  populated: boolean;
  entry_count?: number;
}

export interface ProductManagerCompliance {
  total_pain_points: number;
  mapped: number;
  unmapped: number;
  pct: number;
}

export interface ProductManagerData {
  hasData: boolean;
  status: 'not_started' | 'pending_approval' | 'approved' | 'in_progress' | 'completed';
  sections_populated: number;
  total_sections: 6;
  sections: ProductManagerSectionInfo[];
  compliance: ProductManagerCompliance | null;
  last_updated: string | null;
}

// ============================================================================
// Reader
// ============================================================================

const EMPTY: ProductManagerData = {
  hasData: false,
  status: 'not_started',
  sections_populated: 0,
  total_sections: 6,
  sections: [],
  compliance: null,
  last_updated: null,
};

export function getProductManagerData(): ProductManagerData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'product-manager.db');

  if (!fs.existsSync(dbPath)) {
    return EMPTY;
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return EMPTY;
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    // Force WAL init
    db.pragma('journal_mode');
  } catch {
    // Fall back to temp copy for root-owned dirs
    try {
      const os = require('os');
      const tmpPath = path.join(
        os.tmpdir(),
        `gentyr-ro-product-manager-${process.pid}-${Date.now()}.db`
      );
      fs.copyFileSync(dbPath, tmpPath);
      const tmpDb = new Database(tmpPath);
      tmpDb.pragma('journal_mode = DELETE');
      tmpDb.close();
      db = new Database(tmpPath, { readonly: true });
      const originalClose = db.close.bind(db);
      db.close = () => {
        const result = originalClose();
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
        return result;
      };
    } catch {
      return EMPTY;
    }
  }

  try {
    // Read meta
    const meta = db.prepare("SELECT * FROM analysis_meta WHERE id = 'default'").get() as {
      status: string;
      last_updated_at: string | null;
    } | undefined;

    if (!meta) {
      db.close();
      return EMPTY;
    }

    // Read sections
    const sections = db.prepare('SELECT * FROM sections ORDER BY section_number').all() as Array<{
      section_number: number;
      title: string;
      content: string | null;
    }>;

    const sectionInfos: ProductManagerSectionInfo[] = [];
    let populatedCount = 0;

    for (const sec of sections) {
      const isListSection = sec.section_number === 2 || sec.section_number === 6;
      let populated = false;
      let entryCount: number | undefined;

      if (isListSection) {
        const count = (db.prepare(
          'SELECT COUNT(*) as c FROM section_entries WHERE section_number = ?'
        ).get(sec.section_number) as { c: number }).c;
        populated = count > 0;
        entryCount = count;
      } else {
        populated = !!sec.content;
      }

      if (populated) populatedCount++;

      const info: ProductManagerSectionInfo = {
        number: sec.section_number,
        title: sec.title,
        populated,
      };
      if (entryCount !== undefined) {
        info.entry_count = entryCount;
      }
      sectionInfos.push(info);
    }

    // Compliance stats (only if section 6 has entries)
    let compliance: ProductManagerCompliance | null = null;
    const totalPainPoints = (db.prepare(
      "SELECT COUNT(*) as c FROM section_entries WHERE section_number = 6"
    ).get() as { c: number }).c;

    if (totalPainPoints > 0) {
      const mapped = (db.prepare(
        "SELECT COUNT(DISTINCT pain_point_id) as c FROM pain_point_personas"
      ).get() as { c: number }).c;

      compliance = {
        total_pain_points: totalPainPoints,
        mapped,
        unmapped: totalPainPoints - mapped,
        pct: Math.round((mapped / totalPainPoints) * 100),
      };
    }

    db.close();

    return {
      hasData: true,
      status: meta.status as ProductManagerData['status'],
      sections_populated: populatedCount,
      total_sections: 6,
      sections: sectionInfos,
      compliance,
      last_updated: meta.last_updated_at,
    };
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return EMPTY;
  }
}
