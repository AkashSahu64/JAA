import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, TrendingUp } from 'lucide-react';
import { fetchApplicationFunnel, fetchApplicationTimeline, fetchStats } from '../services/api';
import { ApplicationFunnelRow, DashboardStats } from '../types';

export const AnalyticsView: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [timeline, setTimeline] = useState<Array<{ date: string; count: number }>>([]);
  const [funnel, setFunnel] = useState<ApplicationFunnelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([fetchStats(), fetchApplicationTimeline(30), fetchApplicationFunnel(30)])
      .then(([dashboard, history, lifecycle]) => { setStats(dashboard); setTimeline(history); setFunnel(lifecycle); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load analytics.'))
      .finally(() => setLoading(false));
  }, []);

  const maxCount = useMemo(() => Math.max(1, ...timeline.map((item) => item.count)), [timeline]);

  if (loading) return <State text="Loading analytics…" />;
  if (error) return <State text={error} error />;
  if (!stats) return <State text="Analytics are unavailable." error />;

  return <div className="space-y-6">
    {stats.interviewRounds && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">Interview rounds</h2><p className="text-xs text-slate-400 mt-3">{stats.interviewRounds.total} recorded · highest round {stats.interviewRounds.highestRound || '—'}</p><div className="text-xs text-slate-500 mt-2">{Object.entries(stats.interviewRounds.byRound).sort(([a], [b]) => Number(a) - Number(b)).map(([round, count]) => `Round ${round}: ${count}`).join(' · ') || 'No interview rounds recorded.'}</div></section>}
    {stats.offerOutcomes && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">Offer outcomes</h2><p className="text-xs text-slate-400 mt-3">{stats.offerOutcomes.total} recorded offers</p><div className="text-xs text-slate-500 mt-2">{Object.entries(stats.offerOutcomes.byStatus).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status.replace(/_/g, ' ')}: ${count}`).join(' · ') || 'No offer outcomes recorded.'}</div></section>}
    <div><h1 className="text-2xl font-bold text-white">Analytics</h1><p className="text-xs text-slate-400">Live statistics derived from your stored jobs, resumes, and applications.</p></div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric label="Jobs discovered" value={stats.jobsDiscovered.toLocaleString()} />
      <Metric label="Applications (30d)" value={stats.applicationsThisMonth.toLocaleString()} />
      <Metric label="Interview rate" value={`${stats.interviewRate.toFixed(1)}%`} />
      <Metric label="Response rate" value={`${stats.responseRate.toFixed(1)}%`} />
      <Metric label="Offer rate" value={`${(stats.offerRate ?? 0).toFixed(1)}%`} />
      <Metric label="Rejection rate" value={`${(stats.rejectionRate ?? 0).toFixed(1)}%`} />
      <Metric label="Confirmed submission" value={`${(stats.submissionSuccessRate ?? 0).toFixed(1)}%`} />
    </div>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      <h2 className="font-bold text-sm text-white flex gap-2"><BarChart3 className="w-4 h-4 text-indigo-400" />Applications over the last 30 days</h2>
      {timeline.length === 0 ? <p className="text-sm text-slate-500">No application records were created in this period.</p> : <div className="space-y-2">{timeline.map((item) => <div key={item.date} className="grid grid-cols-[6rem_1fr_2rem] items-center gap-3 text-xs"><span className="text-slate-400 font-mono">{item.date}</span><div className="h-2.5 rounded-full bg-slate-950 overflow-hidden"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(4, item.count / maxCount * 100)}%` }} /></div><span className="text-right text-slate-300">{item.count}</span></div>)}</div>}
    </section>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4"><h2 className="font-bold text-sm text-white">Historical lifecycle funnel</h2>{funnel.length === 0 ? <p className="text-sm text-slate-500">No application lifecycle records were created in this period.</p> : <div className="space-y-2">{funnel.map((row) => <div key={row.date} className="flex items-center justify-between gap-4 text-xs"><span className="font-mono text-slate-400">{row.date}</span><span className="text-slate-300">{row.total} total</span><span className="text-right text-slate-500">{Object.entries(row.statuses).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status.replace(/_/g, ' ')}: ${count}`).join(' · ')}</span></div>)}</div>}</section>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white flex gap-2"><TrendingUp className="w-4 h-4 text-emerald-400" />Quality averages</h2><div className="grid grid-cols-2 gap-3 mt-4"><Metric label="Match score" value={`${stats.averageMatchScore.toFixed(1)}%`} /><Metric label="ATS score" value={`${stats.averageATSScore.toFixed(1)}%`} /></div></section>
    {stats.lifecycleCounts && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">Application lifecycle</h2><div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">{Object.entries(stats.lifecycleCounts).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => <Metric key={status} label={status.split('_').join(' ')} value={count.toLocaleString()} />)}</div></section>}
    {stats.providerMetrics && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">Provider outcomes</h2><div className="space-y-2 mt-4">{Object.entries(stats.providerMetrics).sort(([a], [b]) => a.localeCompare(b)).map(([provider, metric]) => <div key={provider} className="flex items-center justify-between text-xs"><span className="font-mono text-slate-300">{provider}</span><span className="text-slate-400">{metric.total} total · {metric.confirmed} confirmed · {metric.failed} failed · {metric.confirmedRate.toFixed(1)}% success</span></div>)}</div></section>}
    {stats.roleMetrics && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">Role outcomes</h2><div className="space-y-2 mt-4">{Object.entries(stats.roleMetrics).sort(([a], [b]) => a.localeCompare(b)).map(([role, metric]) => <div key={role} className="flex items-center justify-between text-xs"><span className="text-slate-300 truncate max-w-56">{role}</span><span className="text-slate-400">{metric.total} total · {metric.confirmed} confirmed · {metric.failed} failed · {metric.confirmedRate.toFixed(1)}% success</span></div>)}</div></section>}
    {stats.failureReasons && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">Failure reasons</h2><div className="space-y-2 mt-4">{Object.entries(stats.failureReasons).sort(([, a], [, b]) => b - a).map(([code, count]) => <div key={code} className="flex items-center justify-between text-xs"><span className="font-mono text-slate-300">{code}</span><span className="text-slate-400">{count}</span></div>)}{Object.keys(stats.failureReasons).length === 0 && <p className="text-sm text-slate-500">No recorded failures.</p>}</div></section>}
    {stats.resumeVersionPerformance && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">Resume-version performance</h2><div className="space-y-2 mt-4">{Object.entries(stats.resumeVersionPerformance).map(([version, metric]) => <div key={version} className="flex items-center justify-between text-xs"><span className="font-mono text-slate-300 truncate max-w-48">{version}</span><span className="text-slate-400">{metric.applications} applications · {metric.confirmed} confirmed · {metric.failed} failed</span></div>)}{Object.keys(stats.resumeVersionPerformance).length === 0 && <p className="text-sm text-slate-500">No resume-version application records.</p>}</div></section>}
    {stats.atsScoreDistribution && <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-sm text-white">ATS score distribution</h2><div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4"><Metric label="Below 60" value={stats.atsScoreDistribution.below60.toLocaleString()} /><Metric label="60–79" value={stats.atsScoreDistribution.from60To79.toLocaleString()} /><Metric label="80–89" value={stats.atsScoreDistribution.from80To89.toLocaleString()} /><Metric label="90–100" value={stats.atsScoreDistribution.from90To100.toLocaleString()} /></div><div className="space-y-1 mt-4">{stats.averageTimeToSubmissionHours !== undefined && <p className="text-xs text-slate-400">Average time to submission: {stats.averageTimeToSubmissionHours.toFixed(1)} hours</p>}{stats.averageTimeToConfirmationHours !== undefined && <p className="text-xs text-slate-400">Average time to independent confirmation: {stats.averageTimeToConfirmationHours.toFixed(1)} hours</p>}</div></section>}
  </div>;
};

const Metric = ({ label, value }: { label: string; value: string }) => <div className="p-4 rounded-xl bg-slate-950 border border-slate-800"><p className="text-[10px] uppercase text-slate-500">{label}</p><p className="text-xl font-bold text-white mt-1">{value}</p></div>;
const State = ({ text, error = false }: { text: string; error?: boolean }) => <div role={error ? 'alert' : 'status'} className={`p-8 rounded-2xl bg-slate-900 border text-center text-sm flex justify-center gap-2 ${error ? 'border-rose-500/30 text-rose-300' : 'border-slate-800 text-slate-400'}`}>{error && <AlertTriangle className="w-5 h-5" />}{text}</div>;
