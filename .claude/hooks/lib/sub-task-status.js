/**
 * Shared resolver for sub-task statuses that survives todo.db archival.
 *
 * Mirrors `packages/mcp-servers/src/persistent-task/sub-task-status.ts`. When a
 * completed sub-task is moved from `tasks` to `archived_tasks` (by the
 * todo-maintenance sweep after 3h, or by interactive delete), the link row in
 * `persistent-tasks.db.sub_tasks` still references it but the original row is
 * gone. Querying only `tasks` makes the completion silently vanish from
 * `sub_task_counts.completed`. Reading the UNION restores accurate state.
 *
 * @param {import('better-sqlite3').Database} todoDb
 * @param {ReadonlyArray<string>} todoTaskIds
 * @returns {Map<string, { id: string, title: string|null, status: string, section: string|null, category_id: string|null, archived: boolean }>}
 */
export function resolveSubTaskStatuses(todoDb, todoTaskIds) {
  const out = new Map();
  if (!todoTaskIds || todoTaskIds.length === 0) return out;

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
  const rows = todoDb.prepare(sql).all(...params);
  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      title: row.title ?? null,
      status: row.status,
      section: row.section ?? null,
      category_id: row.category_id ?? null,
      archived: row.archived === 1,
    });
  }
  return out;
}
