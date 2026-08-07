import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FolderOpen, FileArchive, GitBranch, Container, Rocket, Check, Lock,
  Folder, FileCode, ChevronRight, ChevronDown, Package, AlertTriangle,
  Sparkles, ShieldCheck, RefreshCw, Eye, X, GitCompare, ExternalLink,
  PlayCircle, HardDriveDownload, Github,
} from 'lucide-react';
import { useStore, useActiveProject } from '@core/store';
import { api, type GenPreview, type GenAction, type ExportReport } from '@core/api';
import { Card, Button, Badge, Toggle, SectionTitle, timeAgo } from '@ui/primitives';
import PublishDialog from './PublishDialog';
import RunPanel from './RunPanel';
import DiffViewer from './DiffViewer';

type FormatId = 'folder' | 'zip' | 'git' | 'docker' | 'production';

const ACTION_TONE: Record<GenAction, string> = {
  create:   'text-emerald-300 bg-emerald-500/15 border-emerald-500/30',
  update:   'text-indigo-300 bg-primary/15 border-primary/30',
  merge:    'text-violet-300 bg-violet-500/15 border-violet-500/30',
  conflict: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
  skip:     'text-muted bg-raise border-line',
};

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

interface TreeNode { name: string; children?: Map<string, TreeNode>; full?: string }

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map() };
  for (const p of paths) {
    let node = root;
    p.split('/').forEach((part, i, arr) => {
      if (!node.children) node.children = new Map();
      if (!node.children.has(part)) {
        node.children.set(part, i === arr.length - 1 ? { name: part, full: p } : { name: part, children: new Map() });
      }
      node = node.children.get(part)!;
    });
  }
  return root;
}

function Tree({ node, depth = 0, onPick }: { node: TreeNode; depth?: number; onPick: (p: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ backend: true, frontend: true, app: true });
  if (!node.children) return null;
  const entries = [...node.children.values()].sort((a, b) => {
    const ad = a.children ? 0 : 1, bd = b.children ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name);
  });
  return (
    <div>
      {entries.map((child) => {
        const isDir = !!child.children;
        const isOpen = open[child.name] ?? depth >= 1;
        return (
          <div key={child.name}>
            <div
              onClick={() => (isDir ? setOpen((o) => ({ ...o, [child.name]: !isOpen })) : onPick(child.full!))}
              className={clsx('flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-[3px] font-mono text-[11.5px] transition',
                isDir ? 'text-txt hover:bg-raise' : 'text-muted hover:bg-raise hover:text-indigo-300')}
              style={{ paddingLeft: depth * 14 + 6 }}
            >
              {isDir ? (
                <>{isOpen ? <ChevronDown size={11} className="shrink-0 text-muted" /> : <ChevronRight size={11} className="shrink-0 text-muted" />}
                  <Folder size={11} className="shrink-0 text-indigo-300" /></>
              ) : (
                <><span className="w-[11px] shrink-0" /><FileCode size={11} className="shrink-0 text-muted/60" /></>
              )}
              <span className="truncate">{child.name}</span>
            </div>
            {isDir && isOpen && <Tree node={child} depth={depth + 1} onPick={onPick} />}
          </div>
        );
      })}
    </div>
  );
}

export default function ExportPage() {
  const project = useActiveProject();
  const notify = useStore((s) => s.notify);
  const refresh = useStore((s) => s.refresh);

  const [format, setFormat] = useState<FormatId>('folder');
  const [publishOpen, setPublishOpen] = useState(false);
  const [preview, setPreview] = useState<GenPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'' | 'generate' | 'zip' | 'dry'>('');
  const [report, setReport] = useState<ExportReport | null>(null);
  const [zipInfo, setZipInfo] = useState<{ path: string; bytes: number; ratio: number } | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [runScripts, setRunScripts] = useState(true);
  const [viewer, setViewer] = useState<{ path: string; content: string } | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);

  const pid = project?.id;

  const load = async () => {
    if (!pid) return;
    setLoading(true);
    try { setPreview(await api.genPreview(pid)); }
    catch (e) { notify(e instanceof Error ? e.message : 'Preview failed', 'err'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [pid]);

  const conflicts = preview?.counts.conflict ?? 0;
  const tree = useMemo(() => buildTree(preview?.tree ?? []), [preview]);
  const changed = useMemo(() => (preview?.files ?? []).filter((f) => f.action !== 'skip'), [preview]);

  if (!project) return null;

  const runGenerate = async (dryRun = false) => {
    if (!pid) return;
    setBusy(dryRun ? 'dry' : 'generate');
    if (!dryRun) setReport(null);
    try {
      const res = await api.generate(pid, {
        overwriteConflicts: overwrite,
        includeRunScripts: runScripts,
        dryRun,
      });
      if (dryRun) {
        notify(`Dry run: ${res.changed ?? 0} file(s) would change`, 'info');
        await load();
      } else {
        setReport(res.report ?? null);
        notify(`${res.written} files written`, 'ok');
        await Promise.all([load(), refresh()]);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Generate failed', 'err');
    } finally { setBusy(''); }
  };

  const runZip = async () => {
    if (!pid) return;
    setBusy('zip');
    try {
      const res = await api.exportZip(pid, { includeRunScripts: runScripts });
      setZipInfo({ path: res.path, bytes: res.bytes, ratio: res.ratio });
      notify(`ZIP created — ${kb(res.bytes)}`, 'ok');
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'ZIP failed', 'err');
    } finally { setBusy(''); }
  };

  const openFolder = async (path?: string) => {
    if (!pid) return;
    try {
      const res = await api.reveal(pid, path);
      if (!res.opened) notify('Could not open the file manager', 'err');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Nothing to open yet', 'err');
    }
  };

  const openFile = async (path: string) => {
    if (!pid) return;
    try { setViewer(await api.genFile(pid, path)); }
    catch { notify('Could not read that file', 'err'); }
  };

  const FORMATS: { id: FormatId; label: string; desc: string; icon: React.ElementType; soon?: boolean }[] = [
    { id: 'folder',     label: 'Folder',             desc: 'Write files straight to disk',        icon: FolderOpen },
    { id: 'zip',        label: 'ZIP',                desc: 'One compressed archive',              icon: FileArchive },
    { id: 'docker',     label: 'Docker Ready',       desc: project.stack.docker ? 'Dockerfile, compose and nginx included' : 'Enable Docker in the wizard', icon: Container },
    { id: 'git',        label: 'GitHub Repository',  desc: 'Create a repo and push this project', icon: Github },
    { id: 'production', label: 'Deployment Starter', desc: 'Not built yet — on the roadmap',      icon: Rocket, soon: true },
  ];

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-5 flex items-center gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-txt">Export</h1>
          <p className="text-[13px] text-muted">
            {project.name} · last generated {timeAgo(project.lastBuildAt)}
          </p>
        </div>
        <div className="ms-auto flex gap-2">
          <Button variant="ghost" onClick={() => openFolder()}>
            <ExternalLink size={15} /> Open Folder
          </Button>
          <Button variant="ghost" onClick={load} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_380px]">
        <div>
          <SectionTitle>Format</SectionTitle>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {FORMATS.map((f) => {
              const Icon = f.icon;
              const active = format === f.id;
              const disabled = f.soon || (f.id === 'docker' && !project.stack.docker);
              return (
                <button key={f.id} disabled={disabled} onClick={() => setFormat(f.id)}
                  className={clsx('relative flex items-start gap-3 rounded-xl border p-4 text-start transition-all duration-200',
                    disabled ? 'cursor-not-allowed border-line bg-raise opacity-45'
                      : active ? 'border-primary bg-primary/15 shadow-glow'
                        : 'border-line bg-raise hover:border-primary/50 hover:bg-raise')}>
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-indigo-300"><Icon size={16} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-txt">{f.label}</p>
                    <p className="text-[12px] text-muted">{f.desc}</p>
                  </div>
                  {f.soon && (
                    <span className="mt-0.5 shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      Soon
                    </span>
                  )}
                  {active && !disabled && (
                    <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-primary">
                      <Check size={12} className="text-white" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* GitHub is not a file format — it publishes what is already on
              disk, so it gets its own panel instead of the generate flow. */}
          {format === 'git' && (
            <div className="mt-5">
              <SectionTitle>Publish</SectionTitle>
              <Card className="p-4">
                <p className="text-[13px] text-muted">
                  Creates a repository on your GitHub account and pushes this
                  project to it. Your token is stored by your operating system,
                  never in Skaffo's database.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button onClick={() => setPublishOpen(true)} disabled={!preview}>
                    <Github size={15} /> Create &amp; push
                  </Button>
                  {!preview && (
                    <span className="text-[12.5px] text-muted">
                      Generate the project first.
                    </span>
                  )}
                </div>
              </Card>
            </div>
          )}

          <div className={clsx('mt-5', format === 'git' && 'hidden')}>
            <SectionTitle right={preview && <Badge tone="primary">{preview.fileCount} files</Badge>}>
              {format === 'zip' ? 'Create archive' : 'Generate'}
            </SectionTitle>
            <Card className="p-4">
              {loading && !preview ? (
                <p className="py-6 text-center text-[13px] text-muted">Rendering preview…</p>
              ) : preview ? (
                <>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-2.5 text-[13px] sm:grid-cols-4">
                    {[
                      ['Files', String(preview.fileCount)],
                      ['Lines', preview.lines.toLocaleString()],
                      ['Size', kb(preview.bytes)],
                      ['Changed', String(preview.changed ?? changed.length)],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <p className="text-[11px] uppercase tracking-wider text-muted">{k}</p>
                        <p className="text-[15px] font-semibold text-txt">{v}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3.5 flex flex-wrap gap-1.5 border-t border-line pt-3.5">
                    {(['create', 'merge', 'update', 'conflict', 'skip'] as GenAction[]).map((a) =>
                      preview.counts[a] ? (
                        <span key={a} className={clsx('rounded-md border px-2 py-0.5 text-[11px] font-medium', ACTION_TONE[a])}>
                          {preview.counts[a]} {a}
                        </span>
                      ) : null,
                    )}
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <p className="flex-1 truncate font-mono text-[11.5px] text-muted">
                      {format === 'zip' ? preview.zipPath : preview.target}
                    </p>
                  </div>

                  <div className="mt-3 flex items-center justify-between rounded-lg border border-line bg-well px-3 py-2">
                    <span className="flex items-center gap-2 text-[12.5px] text-txt">
                      <PlayCircle size={14} className="text-indigo-300" />
                      Include <code className="rounded bg-well px-1 font-mono text-[11px] text-indigo-300">run.bat</code> / <code className="rounded bg-well px-1 font-mono text-[11px] text-indigo-300">run.sh</code>
                    </span>
                    <Toggle on={runScripts} onChange={setRunScripts} />
                  </div>

                  {conflicts > 0 && format !== 'zip' && (
                    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
                      <div className="flex-1">
                        <p className="text-[12.5px] font-medium text-txt">
                          {conflicts} file{conflicts > 1 ? 's' : ''} changed outside a protected region
                        </p>
                        <p className="mt-0.5 text-[11.5px] text-muted">
                          Skipped by default. Click a file below to see exactly what would change.
                        </p>
                        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-amber-200">
                          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)}
                            className="h-3.5 w-3.5 accent-amber-400" />
                          Overwrite them anyway
                        </label>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {format === 'zip' ? (
                      <Button size="lg" onClick={runZip} disabled={busy !== ''} className="min-w-[160px]">
                        {busy === 'zip'
                          ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> Zipping…</>
                          : <><HardDriveDownload size={17} /> Create ZIP</>}
                      </Button>
                    ) : (
                      <>
                        <Button size="lg" onClick={() => runGenerate(false)} disabled={busy !== ''} className="min-w-[150px]">
                          {busy === 'generate'
                            ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> Generating…</>
                            : <><Package size={17} /> Generate</>}
                        </Button>
                        <Button size="lg" variant="outline" onClick={() => runGenerate(true)} disabled={busy !== ''}>
                          {busy === 'dry' ? 'Checking…' : <><Eye size={16} /> Dry run</>}
                        </Button>
                      </>
                    )}
                  </div>

                  {zipInfo && format === 'zip' && (
                    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                      className="mt-3 flex items-center gap-3 rounded-lg border border-success/30 bg-success/10 p-3">
                      <Check size={16} className="shrink-0 text-emerald-300" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[11.5px] text-txt">{zipInfo.path}</p>
                        <p className="text-[11.5px] text-muted">{kb(zipInfo.bytes)} · {zipInfo.ratio}% smaller</p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => openFolder(zipInfo.path)}>
                        <ExternalLink size={13} /> Open
                      </Button>
                    </motion.div>
                  )}
                </>
              ) : (
                <p className="py-6 text-center text-[13px] text-danger">Preview unavailable.</p>
              )}
            </Card>
          </div>

          {report && format !== 'zip' && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-5">
              <SectionTitle right={<Badge tone="success">next step</Badge>}>Run it</SectionTitle>
              <RunPanel targetDir={report.target || preview?.target || ''} />
            </motion.div>
          )}

          {report && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-5">
              <SectionTitle right={<Badge tone="success">done</Badge>}>Report</SectionTitle>
              <Card className="p-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
                  {[
                    ['Written', report.written, 'text-emerald-300'],
                    ['Merged', report.merged, 'text-violet-300'],
                    ['Skipped', report.skipped, 'text-muted'],
                    ['Conflicts', report.conflicts, 'text-amber-300'],
                  ].map(([k, v, tone]) => (
                    <div key={k as string}>
                      <p className="text-[11px] uppercase tracking-wider text-muted">{k}</p>
                      <p className={clsx('text-[17px] font-semibold', tone as string)}>{v as number}</p>
                    </div>
                  ))}
                </div>

                <div className="mt-3.5 border-t border-line pt-3">
                  <p className="mb-2 text-[11px] uppercase tracking-wider text-muted">Files by area</p>
                  <div className="space-y-1.5">
                    {Object.entries(report.byArea).map(([area, n]) => (
                      <div key={area} className="flex items-center gap-2">
                        <span className="w-20 shrink-0 font-mono text-[11.5px] text-txt">{area}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${(n / report.files) * 100}%` }}
                            transition={{ duration: 0.5 }} className="h-full rounded-full bg-primary" />
                        </div>
                        <span className="w-8 shrink-0 text-end text-[11.5px] text-muted">{n}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <Button size="sm" variant="outline" className="mt-3.5 w-full" onClick={() => openFolder()}>
                  <ExternalLink size={13} /> Open output folder
                </Button>
              </Card>
            </motion.div>
          )}

          {changed.length > 0 && (
            <div className="mt-5">
              <SectionTitle right={<Badge>{changed.length}</Badge>}>Changes</SectionTitle>
              <Card className="max-h-[280px] overflow-y-auto p-2">
                {changed.map((f) => (
                  <div key={f.path} className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition hover:bg-raise">
                    <span className={clsx('w-[68px] shrink-0 rounded border py-0.5 text-center text-[10px] font-semibold uppercase', ACTION_TONE[f.action])}>
                      {f.action}
                    </span>
                    <button onClick={() => openFile(f.path)} className="flex-1 truncate text-start font-mono text-[11.5px] text-txt hover:text-indigo-300">
                      {f.path}
                    </button>
                    {f.kept_regions > 0 && (
                      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-violet-300">
                        <ShieldCheck size={11} /> {f.kept_regions}
                      </span>
                    )}
                    <button onClick={() => setDiffPath(f.path)} title="View diff"
                      className="shrink-0 rounded p-1 text-muted opacity-0 transition hover:bg-raise hover:text-indigo-300 group-hover:opacity-100">
                      <GitCompare size={12} />
                    </button>
                  </div>
                ))}
              </Card>
            </div>
          )}

          <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-primary/25 bg-primary/10 p-3.5">
            <Sparkles size={15} className="mt-0.5 shrink-0 text-indigo-300" />
            <p className="text-[12px] leading-relaxed text-muted">
              Code between <code className="rounded bg-well px-1 font-mono text-[11px] text-indigo-300">skaffo:keep:start</code> and{' '}
              <code className="rounded bg-well px-1 font-mono text-[11px] text-indigo-300">keep:end</code> is preserved on every
              regeneration. Use <b className="text-txt">Dry run</b> to see what would change first.
            </p>
          </div>
        </div>

        <div>
          <SectionTitle right={<Badge tone="primary">click to view</Badge>}>Output</SectionTitle>
          <Card className="max-h-[620px] overflow-y-auto p-3">
            {preview ? <Tree node={tree} onPick={openFile} /> : <p className="text-[12px] text-muted">—</p>}
          </Card>
        </div>
      </div>

      <AnimatePresence>
        {viewer && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 grid place-items-center bg-scrim p-8 backdrop-blur-sm"
            onClick={() => setViewer(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2 }} onClick={(e) => e.stopPropagation()}
              className="flex h-[76vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl"
            >
              <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
                <FileCode size={15} className="text-indigo-300" />
                <span className="flex-1 truncate font-mono text-[13px] text-txt">{viewer.path}</span>
                <Button size="sm" variant="ghost" onClick={() => { setDiffPath(viewer.path); setViewer(null); }}>
                  <GitCompare size={13} /> Diff
                </Button>
                <button onClick={() => setViewer(null)} className="rounded p-1.5 text-muted transition hover:bg-raise hover:text-danger">
                  <X size={16} />
                </button>
              </div>
              <pre className="flex-1 overflow-auto bg-code p-4 font-mono text-[11.5px] leading-relaxed text-txt/80">
                {viewer.content}
              </pre>
            </motion.div>
          </motion.div>
        )}

        {diffPath && <DiffViewer path={diffPath} onClose={() => setDiffPath(null)} />}
      </AnimatePresence>

      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        projectName={project.name}
        description={project.description || undefined}
        targetDir={preview?.target || ''}
      />
    </div>
  );
}
