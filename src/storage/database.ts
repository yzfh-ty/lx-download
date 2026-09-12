import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const databasePath = path.join(global.lx.dataPath, 'lxserver.sqlite')
fs.mkdirSync(path.dirname(databasePath), { recursive: true })

export const database = new DatabaseSync(databasePath)
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS kv (
    namespace TEXT NOT NULL,
    item_key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, item_key)
  );
  CREATE TABLE IF NOT EXISTS cache_items (
    scope_key TEXT NOT NULL,
    item_key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope_key, item_key)
  );
  CREATE INDEX IF NOT EXISTS idx_cache_items_scope ON cache_items(scope_key);
  CREATE TABLE IF NOT EXISTS download_tasks (
    task_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_download_tasks_status ON download_tasks(status);
`)

export const getJson = <T>(namespace: string, key: string, fallback: T): T => {
  const row = database.prepare('SELECT value FROM kv WHERE namespace = ? AND item_key = ?').get(namespace, key) as { value?: string } | undefined
  if (!row?.value) return fallback
  try { return JSON.parse(row.value) as T } catch { return fallback }
}

export const setJson = (namespace: string, key: string, value: unknown, updatedAt = Date.now()) => {
  database.prepare(`
    INSERT INTO kv(namespace, item_key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, item_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(namespace, key, JSON.stringify(value), updatedAt)
}

export const removeJson = (namespace: string, key: string) => {
  database.prepare('DELETE FROM kv WHERE namespace = ? AND item_key = ?').run(namespace, key)
}

export const listJson = (namespace: string, prefix = '') => {
  const rows = database.prepare('SELECT item_key, value, updated_at FROM kv WHERE namespace = ? AND item_key LIKE ?').all(namespace, `${prefix}%`) as Array<{ item_key: string; value: string; updated_at: number }>
  return rows.map(row => ({
    key: row.item_key,
    value: row.value,
    updatedAt: row.updated_at,
  }))
}

export const loadCacheItems = (scopeKey: string): Array<[string, any]> => {
  const rows = database.prepare('SELECT item_key, value FROM cache_items WHERE scope_key = ?').all(scopeKey) as Array<{ item_key: string; value: string }>
  const entries: Array<[string, any]> = []
  for (const row of rows) {
    try { entries.push([row.item_key, JSON.parse(row.value)]) } catch { /* ignore malformed records */ }
  }
  return entries
}

export const hasCacheItems = (scopeKey: string) => {
  const row = database.prepare('SELECT 1 AS present FROM cache_items WHERE scope_key = ? LIMIT 1').get(scopeKey) as { present?: number } | undefined
  return row?.present === 1
}

export const saveCacheItems = (scopeKey: string, entries: Iterable<[string, unknown]>) => {
  database.exec('BEGIN')
  try {
    database.prepare('DELETE FROM cache_items WHERE scope_key = ?').run(scopeKey)
    const statement = database.prepare('INSERT INTO cache_items(scope_key, item_key, value, updated_at) VALUES (?, ?, ?, ?)')
    const now = Date.now()
    for (const [key, value] of entries) statement.run(scopeKey, key, JSON.stringify(value), now)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export const loadDownloadTasks = () => {
  const rows = database.prepare('SELECT value FROM download_tasks ORDER BY created_at ASC').all() as Array<{ value: string }>
  return rows.flatMap(row => {
    try { return [JSON.parse(row.value)] } catch { return [] }
  })
}

export const saveDownloadTasks = (tasks: Iterable<any>) => {
  database.exec('BEGIN')
  try {
    database.exec('DELETE FROM download_tasks')
    const statement = database.prepare('INSERT INTO download_tasks(task_id, status, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (const task of tasks) {
      statement.run(task.id, task.status || 'waiting', JSON.stringify(task), Number(task.createdAt) || Date.now(), Number(task.updatedAt) || Date.now())
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
