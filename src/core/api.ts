import type { Project, ActivityItem, Table, Column, Relation, CrudOptions, Endpoint } from './types';
import type { Settings } from './store';

/** Electron injects the real port; browser dev falls back to the default. */
const PORT = (globalThis as any).skaffo?.enginePort ?? 8731;
export const API_BASE = `http://127.0.0.1:${PORT}`;


export type GenAction = 'create' | 'update' | 'merge' | 'conflict' | 'skip';

export interface GenFilePlan {
  path: string;
  action: GenAction;
  kept_regions: number;
  old_size: number;
  new_size: number;
}

export interface GenPreview {
  target: string;
  zipPath: string;
  changed: number;
  fileCount: number;
  lines: number;
  bytes: number;
  counts: Partial<Record<GenAction, number>>;
  files: GenFilePlan[];
  tree: string[];
}

export interface GenResult {
  dryRun: boolean;
  report?: ExportReport;
  /** Only present on a dry run: how many files would change. */
  changed?: number;
  counts?: Partial<Record<GenAction, number>>;
  target: string;
  written: number;
  merged: number;
  skipped: number;
  conflicts: number;
  conflictPaths: string[];
  bytes: number;
  fileCount: number;
  lines: number;
  project: Project;
}


// ── Phase 4: schema tools ──
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface SchemaIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  tableId: string | null;
  tableName: string | null;
  columnId: string | null;
  columnName: string | null;
  hint: string | null;
  fixable: boolean;
}

export interface ValidationReport {
  issues: SchemaIssue[];
  errors: number;
  warnings: number;
  infos: number;
  ok: boolean;
}

export type SqlDialect = 'sqlite' | 'postgresql' | 'mysql';

export interface ImportPreview {
  tables: { name: string; columns: number; fields: string[] }[];
  relationCount: number;
}


// ── Phase 6: export ──
export interface ZipResult {
  path: string;
  bytes: number;
  uncompressed: number;
  files: number;
  ratio: number;
  project: Project;
}

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'remove' | 'context';

export interface FileDiff {
  path: string;
  action?: GenAction;
  added: number;
  removed: number;
  keptRegions: number;
  lines: { kind: DiffLineKind; text: string }[];
  truncated: boolean;
  error?: string;
}

export interface ExportReport {
  target: string;
  at: string;
  files: number;
  lines: number;
  bytes: number;
  written: number;
  merged: number;
  skipped: number;
  conflicts: number;
  byArea: Record<string, number>;
  largest: { path: string; bytes: number }[];
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const bridge = (globalThis as any).skaffo?.engine;
  if (bridge?.request) {
    // The token stays in Electron's main process, never in the renderer.
    const { status, data } = await bridge.request({
      path, method: init?.method ?? 'GET', body: init?.body,
    });
    if (status < 200 || status >= 300) {
      throw new ApiError(status, String(data?.detail ?? 'Engine request failed'));
    }
    return data as T;
  }
  // Browser-only development: no Electron bridge. The standalone engine is
  // loopback-only and checks Host and Origin; see docs/SECURITY.md.
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json())?.detail ?? detail; }
    catch { /* non-JSON body */ }
    throw new ApiError(res.status, detail);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  health: () => req<{ status: string; version: string; db: string }>('/health'),

  // ── projects ──
  listProjects: () => req<Project[]>('/api/projects'),
  createProject: (body: {
    name: string; description: string; template: string;
    stack: Project['stack']; path?: string;
  }) => req<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  patchProject: (id: string, body: Partial<Pick<Project, 'name' | 'description' | 'pinned' | 'path'>>) =>
    req<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: string) => req<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  markBuild: (id: string) => req<Project>(`/api/projects/${id}/build`, { method: 'POST' }),
  markExport: (id: string) => req<Project>(`/api/projects/${id}/export`, { method: 'POST' }),

  // ── schema ──
  addTable: (pid: string, body: { name: string; color?: string; position?: { x: number; y: number } }) =>
    req<Table>(`/api/projects/${pid}/schema/tables`, { method: 'POST', body: JSON.stringify(body) }),
  patchTable: (pid: string, tid: string, body: Partial<{ name: string; color: string; position: { x: number; y: number } }>) =>
    req<Table>(`/api/projects/${pid}/schema/tables/${tid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTable: (pid: string, tid: string) =>
    req<void>(`/api/projects/${pid}/schema/tables/${tid}`, { method: 'DELETE' }),
  duplicateTable: (pid: string, tid: string) =>
    req<Table>(`/api/projects/${pid}/schema/tables/${tid}/duplicate`, { method: 'POST' }),

  addColumn: (pid: string, tid: string, body: Partial<Column> & { name: string }) =>
    req<Table>(`/api/projects/${pid}/schema/tables/${tid}/columns`, { method: 'POST', body: JSON.stringify(body) }),
  patchColumn: (pid: string, tid: string, cid: string, body: Partial<Column>) =>
    req<Table>(`/api/projects/${pid}/schema/tables/${tid}/columns/${cid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteColumn: (pid: string, tid: string, cid: string) =>
    req<void>(`/api/projects/${pid}/schema/tables/${tid}/columns/${cid}`, { method: 'DELETE' }),

  addRelation: (pid: string, body: Omit<Relation, 'id'>) =>
    req<Relation>(`/api/projects/${pid}/schema/relations`, { method: 'POST', body: JSON.stringify(body) }),
  deleteRelation: (pid: string, rid: string) =>
    req<void>(`/api/projects/${pid}/schema/relations/${rid}`, { method: 'DELETE' }),

  // ── api designer ──
  generateCrud: (pid: string, entity: string) =>
    req<Project['api']>(`/api/projects/${pid}/api/generate/${entity}`, { method: 'POST' }),
  patchCrudOptions: (pid: string, entity: string, body: Partial<CrudOptions>) =>
    req<Project['api']>(`/api/projects/${pid}/api/crud/${entity}`, { method: 'PATCH', body: JSON.stringify(body) }),
  createEndpoint: (pid: string, body: Partial<Endpoint> & { path: string }) =>
    req<Project['api']>(`/api/projects/${pid}/api/endpoints`,
      { method: 'POST', body: JSON.stringify(body) }),
  patchEndpoint: (pid: string, eid: string, body: Partial<Endpoint>) =>
    req<Project['api']>(`/api/projects/${pid}/api/endpoints/${eid}`,
      { method: 'PATCH', body: JSON.stringify(body) }),
  openapi: (pid: string) =>
    req<Record<string, unknown>>(`/api/projects/${pid}/api/openapi`),

  deleteEndpoint: (pid: string, eid: string) =>
    req<void>(`/api/projects/${pid}/api/endpoints/${eid}`, { method: 'DELETE' }),

  // ── schema tools (Phase 4) ──
  validateSchema: (pid: string) =>
    req<ValidationReport>(`/api/projects/${pid}/schema/validate`),
  ddl: (pid: string, dialect: SqlDialect) =>
    req<{ dialect: string; sql: string }>(`/api/projects/${pid}/schema/ddl?dialect=${dialect}`),
  fixSchema: (pid: string, codes?: string[]) =>
    req<{ applied: string[]; report: ValidationReport; project: Project }>(
      `/api/projects/${pid}/schema/fix`, { method: 'POST', body: JSON.stringify({ codes: codes ?? null }) }),
  previewImport: (pid: string, body: { sql?: string; dbPath?: string }) =>
    req<ImportPreview>(`/api/projects/${pid}/schema/import/preview`,
      { method: 'POST', body: JSON.stringify(body) }),
  importSchema: (pid: string, body: { sql?: string; dbPath?: string; mode: 'replace' | 'merge' }) =>
    req<{ added: number; skipped: number; relations: number; source: string;
          report: ValidationReport; project: Project }>(
      `/api/projects/${pid}/schema/import`, { method: 'POST', body: JSON.stringify(body) }),

  /** Atomic whole-schema swap — used by Undo/Redo. One request, one transaction. */
  replaceSchema: (pid: string, body: {
    tables: { id: string; name: string; color: string; position: { x: number; y: number };
              columns: { name: string; type: string; primaryKey: boolean;
                         nullable: boolean; unique: boolean; defaultValue: string | null }[] }[];
    relations: { kind: string; fromTableId: string; fromColumnIndex: number;
                 toTableId: string; toColumnIndex: number; onDelete: string }[];
  }) => req<{ report: ValidationReport; project: Project }>(
    `/api/projects/${pid}/schema`, { method: 'PUT', body: JSON.stringify(body) }),

  // ── generator ──
  genPreview: (pid: string) =>
    req<GenPreview>(`/api/projects/${pid}/generate/preview`),
  exportZip: (pid: string, body: { path?: string; includeRunScripts?: boolean } = {}) =>
    req<ZipResult>(`/api/projects/${pid}/generate/zip`,
      { method: 'POST', body: JSON.stringify(body) }),
  diff: (pid: string, path: string) =>
    req<FileDiff>(`/api/projects/${pid}/generate/diff?path=${encodeURIComponent(path)}`),
  reveal: (pid: string, path?: string) =>
    req<{ opened: boolean; path: string }>(`/api/projects/${pid}/generate/reveal`,
      { method: 'POST', body: JSON.stringify({ path: path ?? null }) }),
  generate: (pid: string, body: {
    overwriteConflicts?: boolean; path?: string;
    includeRunScripts?: boolean; dryRun?: boolean;
  } = {}) =>
    req<GenResult>(`/api/projects/${pid}/generate`, { method: 'POST', body: JSON.stringify(body) }),
  genFile: (pid: string, path: string) =>
    req<{ path: string; content: string }>(`/api/projects/${pid}/generate/file?path=${encodeURIComponent(path)}`),
  workspace: (pid: string) =>
    req<{ default: string; target: string; exists: boolean }>(`/api/projects/${pid}/generate/workspace`),

  // ── misc ──
  activity: (limit = 40) => req<ActivityItem[]>(`/api/activity?limit=${limit}`),
  getSettings: () => req<Settings>('/api/settings'),
  putSettings: (body: Partial<Settings>) =>
    req<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
};

/** Poll until the Python sidecar answers (it may still be booting). */
export async function waitForEngine(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await api.health();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}
