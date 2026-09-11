import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { fetchApplication, fetchApplications } from '../services/api';
import { UIApplication } from '../types';

export const ApplicationsView: React.FC = () => {
  const [apps, setApps] = useState<UIApplication[]>([]);
  const [selectedApp, setSelectedApp] = useState<UIApplication | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    void fetchApplications().then((data) => {
      setApps(data);
      setSelectedApp(data[0] ?? null);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load applications.')).finally(() => setLoading(false));
  }, []);

  const selectApp = (app: UIApplication) => {
    setSelectedApp(app);
    setDetailLoading(true);
    void fetchApplication(app.id).then(setSelectedApp).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load application details.')).finally(() => setDetailLoading(false));
  };
  const filteredApps = useMemo(() => apps.filter((app) => statusFilter === 'ALL' || app.status === statusFilter), [apps, statusFilter]);
  const statuses = [...new Set(apps.map((app) => app.status))];
  const date = (value?: string) => value ? new Date(value).toLocaleString() : 'Not submitted';

  return <div className="space-y-6">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"><div><h1 className="text-2xl font-bold text-white">Application Queue & Tracker</h1><p className="text-xs text-slate-400">Stored application records and attempt metadata from the authenticated API.</p></div><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter applications by status" className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300"><option value="ALL">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{status.split('_').join(' ')}</option>)}</select></div>
    {loading && <State text="Loading applications…" />}
    {!loading && error && <State text={error} error />}
    {!loading && !error && filteredApps.length === 0 && <State text={apps.length ? 'No applications have this status.' : 'No application records yet. In-app form submission is not available; records appear when created by an integrated workflow.'} />}
    {!loading && !error && filteredApps.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-7 space-y-3">{filteredApps.map((app) => <button type="button" key={app.id} onClick={() => selectApp(app)} aria-pressed={selectedApp?.id === app.id} className={`w-full p-4 rounded-2xl border text-left ${selectedApp?.id === app.id ? 'bg-slate-900 border-indigo-500/60' : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'}`}><div className="flex justify-between gap-3"><div><span className="font-semibold text-xs text-indigo-400">{app.company}</span><h3 className="font-bold text-base text-white">{app.role}</h3><p className="text-[11px] text-slate-400 font-mono">Applied: {date(app.appliedAt)}</p></div><div className="text-right"><StatusBadge status={app.status} /><p className="mt-2 text-[10px] text-slate-400 font-mono">Match: {app.matchScore === undefined ? '—' : `${Math.round(app.matchScore)}%`} · ATS: {app.atsScore === undefined ? '—' : `${Math.round(app.atsScore)}%`}</p></div></div></button>)}</div>
      <div className="lg:col-span-5">{selectedApp && <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-5 sticky top-24"><div className="space-y-1 border-b border-slate-800 pb-4"><div className="flex justify-between"><span className="text-xs font-semibold text-indigo-400">{selectedApp.company}</span><StatusBadge status={selectedApp.status} /></div><h2 className="font-bold text-lg text-white">{selectedApp.role}</h2>{selectedApp.location && <p className="text-xs text-slate-400">{selectedApp.location}</p>}</div>
        {selectedApp.failureReason && <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300"><div className="font-semibold flex gap-1"><AlertTriangle className="w-4 h-4" />Failure details</div><p>{selectedApp.failureReason}</p></div>}
        <div className="space-y-3"><h4 className="text-xs font-bold text-slate-400 uppercase font-mono">Recorded attempts</h4>{detailLoading ? <p className="text-xs text-slate-500">Loading attempt details…</p> : selectedApp.attempts?.length ? selectedApp.attempts.map((attempt) => <div key={attempt.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs"><div className="flex justify-between"><span className="font-bold text-white">Attempt #{attempt.attemptNumber}</span><span className="text-slate-500">{date(attempt.startedAt)}</span></div><p className="text-slate-400 mt-1">Status: {attempt.status} · Fields filled: {attempt.fieldsFilled}/{attempt.fieldsDetected}</p>{attempt.error && <p className="text-rose-300 mt-1">{attempt.error}</p>}</div>) : <p className="text-xs text-slate-500">No attempt records are available. Browser automation and retry controls are not implemented by the current API.</p>}</div>
      </div>}</div>
    </div>}
  </div>;
};

const StatusBadge = ({ status }: { status: string }) => <span className="px-2.5 py-1 rounded-full bg-indigo-500/15 text-indigo-300 text-xs font-mono font-semibold border border-indigo-500/30">{status.split('_').join(' ')}</span>;
const State = ({ text, error = false }: { text: string; error?: boolean }) => <div role={error ? 'alert' : 'status'} className={`p-8 rounded-2xl border bg-slate-900/60 text-center text-sm ${error ? 'border-rose-500/30 text-rose-300' : 'border-slate-800 text-slate-400'}`}>{text}</div>;
