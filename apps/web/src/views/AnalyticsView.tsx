import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, TrendingUp } from 'lucide-react';
import { fetchApplicationTimeline, fetchStats } from '../services/api';
import { DashboardStats } from '../types';

export const AnalyticsView: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [timeline, setTimeline] = useState<Array<{ date: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([fetchStats(), fetchApplicationTimeline(30)])
      .then(([dashboard, history]) => { setStats(dashboard); setTimeline(history); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load analytics.'))
      .finally(() => setLoading(false));
  }, []);

  const maxCount = useMemo(() => Math.max(1, ...timeline.map((item) => item.count)), [timeline]);

  if (loading) return <State text="Loading analytics…" />;
  if (error) return <State text={error} error />;
  if (!stats) return <State text="Analytics are unavailable." error />;

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold text-white">Analytics</h1><p className="text-xs text-slate-400">Live statistics derived from your stored jobs, resumes, and applications.</p></div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric label="Jobs discovered" value={stats.jobsDiscovered.toLocaleString()} />
      <Metric label="Applications (30d)" value={stats.applicationsThisMonth.toLocaleString()} />
      <Metric label="Interview rate" value={`${stats.interviewRate.toFixed(1)}%`} />
      <Metric label="Response rate" value={`${stats.responseRate.toFixed(1)}%`} />
    </div>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      <h2 className="font-bold text-sm text-white flex gap-2"><BarChart3 className="w-4 h-4 text-indigo-400" />Applications over the last 30 days</h2>
      {timeline.length === 0 ? <p className="text-sm text-slate-500">No application records were created in this period.</p> : <div className="space-y-2">{timeline.map((item) => <div key={item.date} className="grid grid-cols-[6rem_1fr_2rem] items-center gap-3 text-xs"><span className="text-slate-400 font-mono">{item.date}</span><div className="h-2.5 rounded-full bg-slate-950 overflow-hidden"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(4, item.count / maxCount * 100)}%` }} /></div><span className="text-right text-slate-300">{item.count}</span></div>)}</div>}
    </section>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white flex gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" />Quality averages</h2><div className="grid grid-cols-2 gap-3 mt-4"><Metric label="Match score" value={`${stats.averageMatchScore.toFixed(1)}%`} /><Metric label="ATS score" value={`${stats.averageATSScore.toFixed(1)}%`} /></div></section>
  </div>;
};

const Metric = ({ label, value }: { label: string; value: string }) => <div className="p-4 rounded-xl bg-slate-950 border border-slate-800"><p className="text-[10px] uppercase text-slate-500">{label}</p><p className="text-xl font-bold text-white mt-1">{value}</p></div>;
const State = ({ text, error = false }: { text: string; error?: boolean }) => <div role={error ? 'alert' : 'status'} className={`p-8 rounded-2xl bg-slate-900 border text-center text-sm flex justify-center gap-2 ${error ? 'border-rose-500/30 text-rose-300' : 'border-slate-800 text-slate-400'}`}>{error && <AlertTriangle className="w-5 h-5" />}{text}</div>;
