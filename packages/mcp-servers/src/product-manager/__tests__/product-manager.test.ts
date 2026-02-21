/**
 * Unit tests for Product Manager MCP Server
 *
 * Tests product-market-fit analysis lifecycle, section CRUD, pain-point-persona
 * mapping, and compliance reporting.
 *
 * Uses in-memory SQLite database for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { createTestDb, isErrorResult } from '../../__testUtils__/index.js';
import {
  ANALYSIS_STATUS,
  SECTION_KEYS,
  LIST_SECTIONS,
  type AnalysisStatus,
  type SectionKey,
  type AnalysisMetaRecord,
  type SectionRecord,
  type SectionEntryRecord,
  type PainPointPersonaRecord,
} from '../types.js';

// ============================================================================
// Schema Definition
// ============================================================================

const PRODUCT_MANAGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_meta (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'not_started',
    initiated_at TEXT,
    initiated_by TEXT,
    approved_at TEXT,
    approved_by TEXT,
    last_updated_at TEXT,
    md_path TEXT NOT NULL DEFAULT '.claude/product-market-fit.md',
    CONSTRAINT valid_status CHECK (status IN (
      'not_started','pending_approval','approved','in_progress','completed'
    ))
);

CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    section_number INTEGER NOT NULL UNIQUE,
    section_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT,
    populated_at TEXT,
    populated_by TEXT,
    updated_at TEXT,
    CONSTRAINT valid_section CHECK (section_number BETWEEN 1 AND 6)
);

CREATE TABLE IF NOT EXISTS section_entries (
    id TEXT PRIMARY KEY,
    section_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT valid_entry_section CHECK (section_number IN (2, 6))
);

CREATE INDEX IF NOT EXISTS idx_entries_section ON section_entries(section_number);

CREATE TABLE IF NOT EXISTS pain_point_personas (
    pain_point_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (pain_point_id, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_ppp_pain_point ON pain_point_personas(pain_point_id);
`;

// ============================================================================
// Seed Data
// ============================================================================

const SECTION_SEEDS: Array<{ number: number; key: SectionKey; title: string }> = [
  { number: 1, key: 'market_space', title: 'Market Space & Players' },
  { number: 2, key: 'buyer_personas', title: 'Buyer Personas' },
  { number: 3, key: 'competitor_differentiation', title: 'Competitor Differentiation' },
  { number: 4, key: 'pricing_models', title: 'Pricing Models' },
  { number: 5, key: 'niche_strengths', title: 'Niche Strengths & Weaknesses' },
  { number: 6, key: 'user_sentiment', title: 'User Sentiment' },
];

// ============================================================================
// Helper Functions (mirror server implementation)
// ============================================================================

function seedDatabase(db: Database.Database): void {
  // Seed sections
  const insertSection = db.prepare(
    'INSERT INTO sections (id, section_number, section_key, title) VALUES (?, ?, ?, ?)'
  );
  for (const seed of SECTION_SEEDS) {
    insertSection.run(randomUUID(), seed.number, seed.key, seed.title);
  }

  // Seed analysis_meta
  db.prepare(
    'INSERT INTO analysis_meta (id, status, md_path) VALUES (?, ?, ?)'
  ).run('default', 'not_started', '.claude/product-market-fit.md');
}

function getAnalysisStatus(db: Database.Database) {
  const meta = db.prepare('SELECT * FROM analysis_meta WHERE id = ?').get('default') as AnalysisMetaRecord;
  const sections = db.prepare('SELECT * FROM sections ORDER BY section_number ASC').all() as SectionRecord[];

  let sectionsPopulated = 0;
  const sectionDetails = sections.map((s) => {
    const isListSection = LIST_SECTIONS.includes(s.section_number as 2 | 6);
    let populated = false;
    let entryCount: number | undefined;

    if (isListSection) {
      const count = (db.prepare('SELECT COUNT(*) as c FROM section_entries WHERE section_number = ?')
        .get(s.section_number) as { c: number }).c;
      entryCount = count;
      populated = count > 0;
    } else {
      populated = s.content !== null && s.content.trim().length > 0;
    }

    if (populated) sectionsPopulated++;

    return {
      number: s.section_number,
      key: s.section_key,
      title: s.title,
      populated,
      ...(entryCount !== undefined && { entry_count: entryCount }),
    };
  });

  return {
    status: meta.status as AnalysisStatus,
    initiated_at: meta.initiated_at,
    initiated_by: meta.initiated_by,
    approved_at: meta.approved_at,
    approved_by: meta.approved_by,
    last_updated_at: meta.last_updated_at,
    sections_populated: sectionsPopulated,
    total_sections: 6 as const,
    sections: sectionDetails,
    compliance: null,
  };
}

function initiateAnalysis(db: Database.Database, initiatedBy: string) {
  const meta = db.prepare('SELECT status FROM analysis_meta WHERE id = ?').get('default') as { status: string };

  if (meta.status !== 'not_started') {
    return { error: `Cannot initiate: current status is ${meta.status}` };
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE analysis_meta SET status = ?, initiated_at = ?, initiated_by = ?, last_updated_at = ? WHERE id = ?')
    .run('pending_approval', now, initiatedBy, now, 'default');

  return {
    status: 'pending_approval' as const,
    initiated_at: now,
    initiated_by: initiatedBy,
  };
}

function approveAnalysis(db: Database.Database, approvedBy: string) {
  const meta = db.prepare('SELECT status FROM analysis_meta WHERE id = ?').get('default') as { status: string };

  if (meta.status !== 'pending_approval') {
    return { error: `Cannot approve: current status is ${meta.status}` };
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE analysis_meta SET status = ?, approved_at = ?, approved_by = ?, last_updated_at = ? WHERE id = ?')
    .run('approved', now, approvedBy, now, 'default');

  return {
    status: 'approved' as const,
    approved_at: now,
    approved_by: approvedBy,
  };
}

function writeSection(db: Database.Database, sectionNumber: number, content: string, populatedBy?: string) {
  // Reject list sections
  if (LIST_SECTIONS.includes(sectionNumber as 2 | 6)) {
    return { error: `Section ${sectionNumber} is a list section. Use add_entry instead.` };
  }

  const section = db.prepare('SELECT * FROM sections WHERE section_number = ?').get(sectionNumber) as SectionRecord | undefined;
  if (!section) {
    return { error: `Section ${sectionNumber} not found` };
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE sections SET content = ?, populated_at = ?, populated_by = ?, updated_at = ? WHERE section_number = ?')
    .run(content, now, populatedBy ?? null, now, sectionNumber);

  // Update analysis status to in_progress if approved
  const meta = db.prepare('SELECT status FROM analysis_meta WHERE id = ?').get('default') as { status: string };
  if (meta.status === 'approved') {
    db.prepare('UPDATE analysis_meta SET status = ?, last_updated_at = ? WHERE id = ?')
      .run('in_progress', now, 'default');
  }

  return {
    section_number: sectionNumber,
    title: section.title,
    populated_at: now,
  };
}

function addEntry(db: Database.Database, args: {
  section: number;
  title: string;
  content: string;
  metadata?: string;
  populated_by?: string;
}) {
  // Validate list section
  if (!LIST_SECTIONS.includes(args.section as 2 | 6)) {
    return { error: `Section ${args.section} is not a list section. Use write_section instead.` };
  }

  const id = randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const createdTimestamp = Math.floor(now.getTime() / 1000);

  db.prepare(`
    INSERT INTO section_entries (id, section_number, title, content, metadata, created_at, created_timestamp, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, args.section, args.title, args.content, args.metadata ?? '{}', createdAt, createdTimestamp, createdAt);

  // Update section populated_at
  db.prepare('UPDATE sections SET populated_at = ?, populated_by = ?, updated_at = ? WHERE section_number = ?')
    .run(createdAt, args.populated_by ?? null, createdAt, args.section);

  // Update analysis status to in_progress if approved
  const meta = db.prepare('SELECT status FROM analysis_meta WHERE id = ?').get('default') as { status: string };
  if (meta.status === 'approved') {
    db.prepare('UPDATE analysis_meta SET status = ?, last_updated_at = ? WHERE id = ?')
      .run('in_progress', createdAt, 'default');
  }

  return {
    id,
    section_number: args.section,
    title: args.title,
    created_at: createdAt,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Product Manager MCP Server', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb(PRODUCT_MANAGER_SCHEMA);
    seedDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // Lifecycle Tests
  // ============================================================================

  describe('Analysis Lifecycle', () => {
    it('should start with not_started status', () => {
      const status = getAnalysisStatus(db);

      expect(status.status).toBe('not_started');
      expect(status.initiated_at).toBeNull();
      expect(status.initiated_by).toBeNull();
      expect(status.approved_at).toBeNull();
      expect(status.approved_by).toBeNull();
    });

    it('should initiate analysis', () => {
      const result = initiateAnalysis(db, 'product-manager');

      expect(result.status).toBe('pending_approval');
      expect(result.initiated_at).toBeDefined();
      expect(result.initiated_by).toBe('product-manager');
    });

    it('should reject initiation if not in not_started state', () => {
      initiateAnalysis(db, 'product-manager');
      const result = initiateAnalysis(db, 'product-manager');

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Cannot initiate');
        expect(result.error).toContain('pending_approval');
      }
    });

    it('should approve analysis', () => {
      initiateAnalysis(db, 'product-manager');
      const result = approveAnalysis(db, 'deputy-cto');

      expect(result.status).toBe('approved');
      expect(result.approved_at).toBeDefined();
      expect(result.approved_by).toBe('deputy-cto');
    });

    it('should reject approval if not in pending_approval state', () => {
      const result = approveAnalysis(db, 'deputy-cto');

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Cannot approve');
        expect(result.error).toContain('not_started');
      }
    });

    it('should transition to in_progress when first section populated', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      writeSection(db, 1, 'Market analysis content', 'product-manager');

      const status = getAnalysisStatus(db);
      expect(status.status).toBe('in_progress');
    });
  });

  // ============================================================================
  // Section Tests
  // ============================================================================

  describe('Section Management', () => {
    it('should seed 6 sections', () => {
      const sections = db.prepare('SELECT * FROM sections ORDER BY section_number').all() as SectionRecord[];

      expect(sections).toHaveLength(6);
      expect(sections[0].section_number).toBe(1);
      expect(sections[0].section_key).toBe('market_space');
      expect(sections[5].section_number).toBe(6);
      expect(sections[5].section_key).toBe('user_sentiment');
    });

    it('should enforce valid section_number constraint', () => {
      expect(() => {
        db.prepare('INSERT INTO sections (id, section_number, section_key, title) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), 7, 'invalid', 'Invalid Section');
      }).toThrow();
    });

    it('should enforce unique section_number', () => {
      expect(() => {
        db.prepare('INSERT INTO sections (id, section_number, section_key, title) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), 1, 'duplicate', 'Duplicate');
      }).toThrow();
    });

    it('should write content to non-list section', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      const result = writeSection(db, 1, '# Market Analysis\n\nContent here', 'product-manager');

      expect(result.section_number).toBe(1);
      expect(result.title).toBe('Market Space & Players');
      expect(result.populated_at).toBeDefined();

      const section = db.prepare('SELECT * FROM sections WHERE section_number = 1').get() as SectionRecord;
      expect(section.content).toBe('# Market Analysis\n\nContent here');
      expect(section.populated_by).toBe('product-manager');
    });

    it('should reject write to list section', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      const result = writeSection(db, 2, 'Content', 'product-manager');

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('list section');
        expect(result.error).toContain('Use add_entry');
      }
    });

    it('should update section content on subsequent write', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      writeSection(db, 1, 'Original content', 'product-manager');
      writeSection(db, 1, 'Updated content', 'product-manager');

      const section = db.prepare('SELECT * FROM sections WHERE section_number = 1').get() as SectionRecord;
      expect(section.content).toBe('Updated content');
    });
  });

  // ============================================================================
  // Section Entry Tests (List Sections)
  // ============================================================================

  describe('Section Entries (List Sections)', () => {
    it('should add entry to list section 2 (buyer_personas)', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      const result = addEntry(db, {
        section: 2,
        title: 'Enterprise SaaS Buyer',
        content: '## Characteristics\n\n- Budget authority\n- Technical savvy',
        populated_by: 'product-manager',
      });

      expect(result.id).toBeDefined();
      expect(result.section_number).toBe(2);
      expect(result.title).toBe('Enterprise SaaS Buyer');
      expect(result.created_at).toBeDefined();
    });

    it('should add entry to list section 6 (user_sentiment)', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      const result = addEntry(db, {
        section: 6,
        title: 'Deployment complexity',
        content: 'Users struggle with multi-region deployments',
        metadata: JSON.stringify({ severity: 'high', source: 'feedback-session-123' }),
        populated_by: 'product-manager',
      });

      expect(result.id).toBeDefined();
      expect(result.section_number).toBe(6);

      const entry = db.prepare('SELECT * FROM section_entries WHERE id = ?').get(result.id) as SectionEntryRecord;
      expect(entry.title).toBe('Deployment complexity');
      expect(JSON.parse(entry.metadata)).toEqual({ severity: 'high', source: 'feedback-session-123' });
    });

    it('should reject add_entry to non-list section', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      const result = addEntry(db, {
        section: 1,
        title: 'Invalid Entry',
        content: 'Should fail',
      });

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('not a list section');
        expect(result.error).toContain('Use write_section');
      }
    });

    it('should enforce valid_entry_section constraint', () => {
      expect(() => {
        const now = new Date();
        db.prepare(`
          INSERT INTO section_entries (id, section_number, title, content, created_at, created_timestamp, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), 3, 'Invalid', 'Content', now.toISOString(), Math.floor(now.getTime() / 1000), now.toISOString());
      }).toThrow();
    });

    it('should store multiple entries for same section', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      addEntry(db, { section: 2, title: 'Persona 1', content: 'Content 1' });
      addEntry(db, { section: 2, title: 'Persona 2', content: 'Content 2' });
      addEntry(db, { section: 2, title: 'Persona 3', content: 'Content 3' });

      const count = (db.prepare('SELECT COUNT(*) as c FROM section_entries WHERE section_number = 2')
        .get() as { c: number }).c;
      expect(count).toBe(3);
    });
  });

  // ============================================================================
  // Status Reporting Tests
  // ============================================================================

  describe('Status Reporting', () => {
    it('should report sections_populated count', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      writeSection(db, 1, 'Content 1', 'product-manager');
      addEntry(db, { section: 2, title: 'Entry 1', content: 'Content' });
      writeSection(db, 3, 'Content 3', 'product-manager');

      const status = getAnalysisStatus(db);
      expect(status.sections_populated).toBe(3);
    });

    it('should include entry_count for list sections', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      addEntry(db, { section: 2, title: 'Entry 1', content: 'C1' });
      addEntry(db, { section: 2, title: 'Entry 2', content: 'C2' });

      const status = getAnalysisStatus(db);
      const section2 = status.sections.find(s => s.number === 2);

      expect(section2?.entry_count).toBe(2);
      expect(section2?.populated).toBe(true);
    });

    it('should mark list section populated when entries exist', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      addEntry(db, { section: 6, title: 'Pain Point', content: 'Content' });

      const status = getAnalysisStatus(db);
      const section6 = status.sections.find(s => s.number === 6);

      expect(section6?.populated).toBe(true);
    });

    it('should mark non-list section populated when content exists', () => {
      initiateAnalysis(db, 'product-manager');
      approveAnalysis(db, 'deputy-cto');

      writeSection(db, 1, 'Market content', 'product-manager');

      const status = getAnalysisStatus(db);
      const section1 = status.sections.find(s => s.number === 1);

      expect(section1?.populated).toBe(true);
    });
  });

  // ============================================================================
  // Pain Point Persona Mapping Tests
  // ============================================================================

  describe('Pain Point Persona Mapping', () => {
    it('should create pain_point_personas mapping', () => {
      const painPointId = randomUUID();
      const personaId = randomUUID();
      const now = new Date().toISOString();

      db.prepare('INSERT INTO pain_point_personas (pain_point_id, persona_id, created_at, created_by) VALUES (?, ?, ?, ?)')
        .run(painPointId, personaId, now, 'product-manager');

      const mapping = db.prepare('SELECT * FROM pain_point_personas WHERE pain_point_id = ? AND persona_id = ?')
        .get(painPointId, personaId) as PainPointPersonaRecord;

      expect(mapping.pain_point_id).toBe(painPointId);
      expect(mapping.persona_id).toBe(personaId);
      expect(mapping.created_by).toBe('product-manager');
    });

    it('should enforce composite primary key', () => {
      const painPointId = randomUUID();
      const personaId = randomUUID();
      const now = new Date().toISOString();

      db.prepare('INSERT INTO pain_point_personas (pain_point_id, persona_id, created_at, created_by) VALUES (?, ?, ?, ?)')
        .run(painPointId, personaId, now, 'product-manager');

      expect(() => {
        db.prepare('INSERT INTO pain_point_personas (pain_point_id, persona_id, created_at, created_by) VALUES (?, ?, ?, ?)')
          .run(painPointId, personaId, now, 'product-manager');
      }).toThrow();
    });

    it('should allow multiple personas per pain point', () => {
      const painPointId = randomUUID();
      const persona1 = randomUUID();
      const persona2 = randomUUID();
      const now = new Date().toISOString();

      db.prepare('INSERT INTO pain_point_personas (pain_point_id, persona_id, created_at, created_by) VALUES (?, ?, ?, ?)')
        .run(painPointId, persona1, now, 'product-manager');
      db.prepare('INSERT INTO pain_point_personas (pain_point_id, persona_id, created_at, created_by) VALUES (?, ?, ?, ?)')
        .run(painPointId, persona2, now, 'product-manager');

      const count = (db.prepare('SELECT COUNT(*) as c FROM pain_point_personas WHERE pain_point_id = ?')
        .get(painPointId) as { c: number }).c;

      expect(count).toBe(2);
    });

    it('should have index on pain_point_id', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ppp_pain_point'")
        .all();
      expect(indexes).toHaveLength(1);
    });
  });

  // ============================================================================
  // Database Indexes Tests
  // ============================================================================

  describe('Database Indexes', () => {
    it('should have index on section_entries.section_number', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entries_section'")
        .all();
      expect(indexes).toHaveLength(1);
    });
  });

  // ============================================================================
  // Validation Tests (G003)
  // ============================================================================

  describe('Input Validation (G003)', () => {
    it('should enforce valid analysis status', () => {
      expect(() => {
        db.prepare('UPDATE analysis_meta SET status = ? WHERE id = ?')
          .run('invalid_status', 'default');
      }).toThrow();
    });

    it('should accept all valid analysis statuses', () => {
      for (const status of ANALYSIS_STATUS) {
        db.prepare('UPDATE analysis_meta SET status = ? WHERE id = ?')
          .run(status, 'default');

        const meta = db.prepare('SELECT status FROM analysis_meta WHERE id = ?')
          .get('default') as { status: string };
        expect(meta.status).toBe(status);
      }
    });

    it('should enforce section_number between 1 and 6', () => {
      expect(() => {
        db.prepare('INSERT INTO sections (id, section_number, section_key, title) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), 0, 'invalid', 'Invalid');
      }).toThrow();

      expect(() => {
        db.prepare('INSERT INTO sections (id, section_number, section_key, title) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), 7, 'invalid', 'Invalid');
      }).toThrow();
    });

    it('should enforce entry section constraint (2 or 6 only)', () => {
      const now = new Date();
      const createdAt = now.toISOString();
      const createdTimestamp = Math.floor(now.getTime() / 1000);

      // Section 2 should work
      db.prepare(`
        INSERT INTO section_entries (id, section_number, title, content, created_at, created_timestamp, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), 2, 'Valid', 'Content', createdAt, createdTimestamp, createdAt);

      // Section 6 should work
      db.prepare(`
        INSERT INTO section_entries (id, section_number, title, content, created_at, created_timestamp, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), 6, 'Valid', 'Content', createdAt, createdTimestamp, createdAt);

      // Section 1 should fail
      expect(() => {
        db.prepare(`
          INSERT INTO section_entries (id, section_number, title, content, created_at, created_timestamp, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), 1, 'Invalid', 'Content', createdAt, createdTimestamp, createdAt);
      }).toThrow();
    });
  });

  // ============================================================================
  // Error Handling Tests (G001)
  // ============================================================================

  describe('Error Handling (G001)', () => {
    it('should fail loudly when writing to non-existent section', () => {
      const result = writeSection(db, 99, 'Content', 'product-manager');

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('not found');
      }
    });

    it('should fail loudly when transitioning from invalid state', () => {
      // Try to approve without initiating
      const result = approveAnalysis(db, 'deputy-cto');

      expect(isErrorResult(result)).toBe(true);
      if (isErrorResult(result)) {
        expect(result.error).toContain('Cannot approve');
        expect(result.error).toContain('current status');
      }
    });
  });
});
