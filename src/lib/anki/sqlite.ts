import type { SqlJsStatic } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

let loading: Promise<SqlJsStatic> | null = null

/** Loads the SQLite engine (WebAssembly) on first use; it ships with the site, so it also works offline. */
export function loadSqlJs(): Promise<SqlJsStatic> {
  loading ??= import('sql.js').then((m) => m.default({ locateFile: () => wasmUrl }))
  return loading
}
