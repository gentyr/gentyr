import Database from 'better-sqlite3';

export interface SubTaskStatusRow {
  id: string;
  title: string | null;
  status: string;
  section: string | null;
  category_id: string | null;
  archived: boolean;
}

interface RawRow {
  id: string;
  title: string | null;
  status: string;
  section: string | null;
  category_id: string | null;
  archived: 0 | 1;
}

export function resolveSubTaskStatuses(
  todoDb: Database.Database,
  todoTaskIds: readonly string[],
): Map<string, SubTaskStatusRow> {
  const out = new Map<string, SubTaskStatusRow>();
  if (todoTaskIds.length === 0) return out;

  const placeholders = todoTaskIds.map(() => '?').join(',');
  const sql = `
    SELECT id, title, status, section, category_id, 0 AS archived
    FROM tasks WHERE id IN (${placeholders})
    UNION ALL
    SELECT id, title,
           COALESCE(original_status, 'completed') AS status,
           section, category_id, 1 AS archived
    FROM archived_tasks
    WHERE id IN (${placeholders}) AND id NOT IN (SELECT id FROM tasks WHERE id IN (${placeholders}))
  `;
  const params = [...todoTaskIds, ...todoTaskIds, ...todoTaskIds];
  const rows = todoDb.prepare(sql).all(...params) as RawRow[];

  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      title: row.title,
      status: row.status,
      section: row.section,
      category_id: row.category_id,
      archived: row.archived === 1,
    });
  }
  return out;
}
