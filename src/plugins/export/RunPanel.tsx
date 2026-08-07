import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, ArrowRight, Check, ChevronRight, Clock, Database,
  ExternalLink, FolderOpen, Globe, Loader2, Play, RefreshCw, Server,
  Sparkles, Terminal, X,
} from 'lucide-react';
import { Badge, Button, Card, SectionTitle } from '@ui/primitives';
import { useStore } from '@core/store';

const w = (globalThis as any).skaffo;

type Tool = {
  found: boolean; version: string | null; ok: boolean;
  required: string; url: string; note: string | null;
};
type Prereqs = { ok: boolean; python: Tool; node: Tool; npm: Tool; error?: string };
type Info = {
  exists: boolean; backend: boolean; frontend: boolean;
  venv: boolean; modules: boolean; seedScript: boolean; seeded: boolean;
  firstRun: boolean; estimateSeconds: number; script: string; hasScript: boolean;
};

type Mode = 'full' | 'backend' | 'frontend' | 'seed' | 'shell';

const MODES: {
  id: Mode; label: string; desc: string; icon: React.ElementType;
  needs?: (i: Info) => boolean; needsLabel?: string;
}[] = [
  { id: 'full',     label: 'Start everything', desc: 'Sets up, then runs the API and the frontend', icon: Play },
  { id: 'backend',  label: 'API only',         desc: 'uvicorn with reload on :8000', icon: Server,
    needs: (i) => i.venv, needsLabel: 'needs first run' },
  { id: 'frontend', label: 'Frontend only',    desc: 'Vite dev server on :5173', icon: Globe,
    needs: (i) => i.modules, needsLabel: 'needs npm install' },
  { id: 'seed',     label: 'Reset sample data', desc: 'Wipes the tables and re-inserts rows', icon: Database,
    needs: (i) => i.venv && i.seedScript, needsLabel: 'needs first run' },
  { id: 'shell',    label: 'Just a shell',     desc: 'A terminal already in the project folder', icon: Terminal },
];

function humanTime(seconds: number) {
  if (seconds < 45) return 'a few seconds';
  const m = Math.round(seconds / 60);
  return m <= 1 ? 'about a minute' : `about ${m} minutes`;
}

/**
 * Run the generated project.
 *
 * Skaffo hands the project to a real terminal rather than running it inside
 * the app. Starting a generated project means creating a virtualenv, pip
 * install, npm install (~3,700 files) and two dev servers — minutes on a
 * Windows machine with a virus scanner. Behind an in-app spinner that looks
 * like a hang; in a terminal the user watches it happen and can read the
 * error when something fails.
 *
 * So this panel's real job is to answer three questions *before* anything
 * opens: will it work, how long will it take, and what exactly will run.
 */
export default function RunPanel({ targetDir }: { targetDir: string }) {
  const notify = useStore((s) => s.notify);

  const [prereqs, setPrereqs] = useState<Prereqs | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [launched, setLaunched] = useState<{ terminal: string; mode: Mode } | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string | null } | null>(null);
  const [showAll, setShowAll] = useState(false);

  const desktop = Boolean(w?.run);

  const refresh = useCallback(async (silent = false) => {
    if (!desktop) return;
    if (!silent) setChecking(true);
    try {
      const [p, i] = await Promise.all([
        w.run.check(),
        targetDir ? w.run.inspect(targetDir) : Promise.resolve(null),
      ]);
      setPrereqs(p);
      setInfo(i && i.ok !== false ? i : null);
    } finally {
      setChecking(false);
    }
  }, [desktop, targetDir]);

  useEffect(() => { refresh(true); }, [refresh]);

  const run = async (mode: Mode) => {
    setBusy(mode);
    setError(null);
    setLaunched(null);
    try {
      const res = await w.run.launch({ dir: targetDir, mode });
      if (!res?.ok) {
        setError({ message: res?.error || 'Could not open a terminal.', hint: res?.hint });
        return;
      }
      setLaunched({ terminal: res.terminal, mode });
      notify(`Opened in ${res.terminal}`, 'ok');
      // The terminal will create the venv / node_modules; re-read shortly so
      // the panel stops claiming a first run is still pending.
      setTimeout(() => refresh(true), 4000);
    } catch (e: any) {
      setError({ message: e?.message || 'Could not open a terminal.' });
    } finally {
      setBusy(null);
    }
  };

  if (!desktop) {
    return (
      <Card className="p-4">
        <p className="text-[13px] text-muted">
          Running a project needs the desktop app — the browser cannot open a terminal.
        </p>
      </Card>
    );
  }

  const tools = prereqs
    ? ([['Python', prereqs.python], ['Node.js', prereqs.node], ['npm', prereqs.npm]] as const)
    : [];
  const missing = tools.filter(([, t]) => !t.ok);
  const ready = prereqs && missing.length === 0;
  const visible = showAll ? MODES : MODES.slice(0, 1);

  return (
    <Card className="overflow-hidden p-0">
      {/* ── header ── */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 ring-1 ring-inset ring-emerald-400/20">
          <Play size={16} className="text-emerald-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-txt">Run this project</h3>
          <p className="truncate text-[12px] text-muted">
            Opens your terminal so you can watch it start
          </p>
        </div>
        <button
          onClick={() => refresh()}
          disabled={checking}
          title="Re-check"
          className="rounded-lg p-2 text-muted transition hover:bg-raise hover:text-txt disabled:opacity-40"
        >
          <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {/* ── prerequisites ── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11.5px] font-medium uppercase tracking-wide text-muted">
              On this machine
            </span>
            {prereqs && (
              <Badge tone={ready ? 'success' : 'danger'}>
                {ready ? 'Ready' : `${missing.length} missing`}
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {!prereqs
              ? [0, 1, 2].map((i) => (
                  <div key={i} className="h-[58px] animate-pulse rounded-xl border border-line bg-raise/40" />
                ))
              : tools.map(([label, tool]) => (
                  <div
                    key={label}
                    className={`rounded-xl border px-3 py-2.5 ${
                      tool.ok ? 'border-line bg-raise/40' : 'border-danger/40 bg-danger/10'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      {tool.ok
                        ? <Check size={12} className="shrink-0 text-success" />
                        : <X size={12} className="shrink-0 text-danger" />}
                      <span className="text-[12.5px] font-medium text-txt">{label}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted" dir="ltr">
                      {tool.version || `not found · needs ${tool.required}`}
                    </p>
                  </div>
                ))}
          </div>

          {/* one actionable box per missing tool, not a generic warning */}
          {prereqs && missing.length > 0 && (
            <div className="mt-2.5 space-y-2">
              {missing.map(([label, tool]) => (
                <div key={label} className="flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-txt">
                      {tool.note || `${label} ${tool.required} is required and was not found on your PATH.`}
                    </p>
                    {label === 'Python' && !tool.found && (
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        On Windows, tick <b className="text-txt">Add Python to PATH</b> in the installer.
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => window.open(tool.url, '_blank')}
                    className="shrink-0 whitespace-nowrap text-[12px] text-primary underline"
                  >
                    Get {label}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── what will happen ── */}
        {info?.exists && (
          <div className="rounded-xl border border-line bg-raise/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Clock size={13} className="text-muted" />
              <span className="text-[12.5px] font-medium text-txt">
                {info.firstRun ? 'First run' : 'Everything is set up'}
              </span>
              <span className="ms-auto text-[12px] text-muted">
                {humanTime(info.estimateSeconds)}
              </span>
            </div>

            <div className="space-y-1.5">
              <Step done={info.venv}
                    label="Python virtualenv"
                    todo="will be created, then pip install" />
              <Step done={info.modules}
                    label="Frontend dependencies"
                    todo="npm install — the slow one" />
              {info.seedScript && (
                <Step done={info.seeded}
                      label="Sample data"
                      todo="rows inserted on first start" />
              )}
            </div>

            {info.firstRun && (
              <p className="mt-2.5 border-t border-line pt-2.5 text-[11.5px] leading-relaxed text-muted">
                The first start downloads dependencies, so it is slow — and on
                Windows a virus scanner inspects every file as it lands. Later
                starts take seconds.
              </p>
            )}
          </div>
        )}

        {/* ── launch buttons ── */}
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {visible.map((m) => {
              const blocked = info && m.needs ? !m.needs(info) : false;
              const primary = m.id === 'full';
              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <button
                    onClick={() => run(m.id)}
                    disabled={!ready || blocked || busy !== null || !info?.exists}
                    className={`group flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-start transition
                      disabled:cursor-not-allowed disabled:opacity-45
                      ${primary
                        ? 'border-primary/40 bg-primary/10 hover:border-primary hover:bg-primary/15'
                        : 'border-line bg-raise/40 hover:border-muted/40 hover:bg-raise'}`}
                  >
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg
                      ${primary ? 'bg-primary/20 text-indigo-200' : 'bg-card text-muted'}`}>
                      {busy === m.id
                        ? <Loader2 size={15} className="animate-spin" />
                        : <m.icon size={15} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[13.5px] font-medium text-txt">{m.label}</span>
                        {blocked && (
                          <span className="rounded-full bg-card px-1.5 py-0.5 text-[10.5px] text-muted">
                            {m.needsLabel}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[12px] text-muted">{m.desc}</span>
                    </span>
                    <ArrowRight
                      size={15}
                      className={`shrink-0 transition-transform ${primary ? 'text-indigo-300' : 'text-muted'} group-hover:translate-x-0.5`}
                    />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>

          <button
            onClick={() => setShowAll((v) => !v)}
            className="flex w-full items-center justify-center gap-1 py-1 text-[12px] text-muted transition hover:text-txt"
          >
            <ChevronRight size={13} className={`transition-transform ${showAll ? 'rotate-90' : ''}`} />
            {showAll ? 'Fewer options' : 'More ways to run it'}
          </button>
        </div>

        {/* ── result ── */}
        <AnimatePresence>
          {launched && (
            <motion.div
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="rounded-xl border border-success/30 bg-success/10 p-3"
            >
              <div className="flex items-start gap-2.5">
                <Check size={14} className="mt-0.5 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-txt">
                    Opened in {launched.terminal}
                  </p>
                  {launched.mode === 'full' && (
                    <p className="mt-1 text-[12px] leading-relaxed text-muted">
                      Two windows will appear once setup finishes. Then open{' '}
                      <button
                        onClick={() => window.open('http://localhost:5173', '_blank')}
                        className="font-mono text-primary underline"
                      >
                        localhost:5173
                      </button>{' '}
                      for the app, or{' '}
                      <button
                        onClick={() => window.open('http://127.0.0.1:8000/docs', '_blank')}
                        className="font-mono text-primary underline"
                      >
                        127.0.0.1:8000/docs
                      </button>{' '}
                      for the API.
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="rounded-xl border border-danger/30 bg-danger/10 p-3"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium text-txt">{error.message}</p>
                  {error.hint && (
                    <p className="mt-1 whitespace-pre-wrap text-[12px] text-muted">{error.hint}</p>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── escape hatch ── */}
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <Button size="sm" variant="ghost" onClick={() => w.run.openFolder(targetDir)}>
            <FolderOpen size={14} /> Open folder
          </Button>
          <span className="truncate font-mono text-[11px] text-muted" dir="ltr" title={targetDir}>
            {targetDir || 'not generated yet'}
          </span>
        </div>
      </div>
    </Card>
  );
}

/** One line of "already done" / "will happen". */
function Step({ done, label, todo }: { done: boolean; label: string; todo: string }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="grid h-4 w-4 shrink-0 place-items-center">
        {done
          ? <Check size={12} className="text-success" />
          : <Sparkles size={11} className="text-amber-300" />}
      </span>
      <span className={done ? 'text-muted line-through decoration-muted/40' : 'text-txt'}>
        {label}
      </span>
      {!done && <span className="truncate text-muted">— {todo}</span>}
    </div>
  );
}
