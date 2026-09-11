import React, { useEffect, useState } from 'react';
import { Briefcase, Send, Award, TrendingUp, AlertTriangle } from 'lucide-react';
import { fetchStats } from '../services/api';
import { DashboardStats, NavView } from '../types';

interface DashboardViewProps {
  onSelectView: (view: NavView) => void;
  automationRunning: boolean;
  automationBusy?: boolean;
  onToggleAutomation: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({ onSelectView, automationRunning, automationBusy = false, onToggleAutomation }) => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    void fetchStats().then(setStats).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load dashboard statistics.')).finally(() => setLoading(false));
  }, []);

  const cards = stats ? [
    { title: 'Jobs Discovered', value: stats.jobsDiscovered.toLocaleString(), detail: `${stats.qualifiedJobs} qualified`, icon: <Briefcase className="w-5 h-5 text-cyan-400" /> },
    { title: 'Applications', value: stats.applicationsThisWeek.toLocaleString(), detail: `${stats.applicationsToday} today`, icon: <Send className="w-5 h-5 text-indigo-400" /> },
    { title: 'Interview Rate', value: `${stats.interviewRate.toFixed(1)}%`, detail: `${stats.responseRate.toFixed(1)}% response rate`, icon: <Award className="w-5 h-5 text-emerald-400" /> },
    { title: 'Average Scores', value: `${stats.averageMatchScore.toFixed(1)} / ${stats.averageATSScore.toFixed(1)}`, detail: 'Match / ATS', icon: <TrendingUp className="w-5 h-5 text-purple-400" /> },
  ] : [];

  return <div className="space-y-6">
    <div className="p-6 rounded-3xl bg-gradient-to-r from-indigo-900/40 via-purple-900/30 to-slate-900 border border-indigo-500/20 flex flex-col md:flex-row md:items-center justify-between gap-4"><div><span className="inline-flex px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-semibold border border-indigo-500/30 mb-2">Authenticated workspace</span><h1 className="text-2xl font-extrabold text-white">Job Application Dashboard</h1><p className="text-sm text-slate-300 max-w-xl">Review discovered jobs, stored resumes, application records, and automation run status. Employer form submission is not implemented in the current backend.</p></div><div className="flex gap-3"><button onClick={() => onSelectView('jobs')} className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs border border-slate-700">Browse jobs</button><button onClick={onToggleAutomation} disabled={automationBusy} className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold text-xs">{automationRunning ? 'Pause run record' : 'Start assisted run'}</button></div></div>
    {loading && <div role="status" className="p-8 text-center rounded-2xl bg-slate-900 border border-slate-800 text-slate-400">Loading dashboard statistics…</div>}
    {!loading && error && <div role="alert" className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex gap-2"><AlertTriangle className="w-5 h-5" />{error}</div>}
    {!loading && stats && <><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">{cards.map((card) => <div key={card.title} className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800"><div className="flex justify-between"><span className="text-xs font-semibold text-slate-400">{card.title}</span><div className="p-2.5 rounded-xl bg-slate-800">{card.icon}</div></div><div className="text-2xl font-extrabold text-white mt-3">{card.value}</div><div className="text-[11px] font-mono text-slate-400 mt-1">{card.detail}</div></div>)}</div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6"><div className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-white">Application pipeline</h2><div className="grid grid-cols-3 gap-3 mt-4"><Metric label="This month" value={stats.applicationsThisMonth} /><Metric label="Pending" value={stats.pendingApplications} /><Metric label="Failed" value={stats.failedApplications} /></div></div><div className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><h2 className="font-bold text-white">Automation status</h2><p className="text-sm text-slate-400 mt-3">{automationRunning ? 'An automation run record is active. Open Automation Control for persisted and live events.' : 'No active run. Starting a run currently updates workflow state only; it does not launch a browser or submit applications.'}</p><button onClick={() => onSelectView('automation')} className="mt-4 text-xs font-semibold text-indigo-400 hover:text-indigo-300">Open Automation Control →</button></div></div>
    </>}
  </div>;
};

const Metric = ({ label, value }: { label: string; value: number }) => <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-center"><span className="text-[10px] text-slate-400 uppercase">{label}</span><div className="text-xl font-bold text-indigo-300">{value}</div></div>;
