import React, { useEffect, useState } from 'react';
import { Play, Terminal, PauseCircle, Info } from 'lucide-react';
import { ApiError, fetchAutomationEvents, fetchAutomationMetrics, streamAutomationEvents, type AutomationMetrics } from '../services/api';
import { AutomationEvent } from '../types';

interface AutomationViewProps {
  automationRunning: boolean;
  automationBusy?: boolean;
  onToggleAutomation: () => void;
}

export const AutomationView: React.FC<AutomationViewProps> = ({ automationRunning, automationBusy = false, onToggleAutomation }) => {
  const [events, setEvents] = useState<AutomationEvent[]>([]);
  const [streamState, setStreamState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [error, setError] = useState('');
  const [metrics, setMetrics] = useState<AutomationMetrics | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let lastEventId: string | undefined;
    void fetchAutomationMetrics().then(setMetrics).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load automation metrics.'));
    const loadHistory = async () => {
      try {
        const data = await fetchAutomationEvents();
        if (data[0]?.id && data[0].id.length <= 200) lastEventId = data[0].id;
        setEvents([...data].reverse());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not load events.');
      }
    };
    const connect = async () => {
      let retryDelay = 1_000;
      while (!controller.signal.aborted) {
        try {
          setStreamState('connecting');
          await streamAutomationEvents((event) => {
            if (event.id && event.id.length <= 200) lastEventId = event.id;
            setStreamState('connected');
            setEvents((current) => [...current.slice(-199), event]);
          }, controller.signal, lastEventId);
          retryDelay = 1_000;
        } catch (cause) {
          if (controller.signal.aborted) return;
          setStreamState('disconnected');
          setError(cause instanceof Error ? cause.message : 'Live stream disconnected.');
          if (cause instanceof ApiError && cause.status === 401) return;
        }
        if (controller.signal.aborted) return;
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, retryDelay);
          controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
        });
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    };
    void loadHistory().then(() => connect());
    return () => controller.abort();
  }, []);

  const messageFor = (event: AutomationEvent) => {
    if (event.message) return event.message;
    if (event.type === 'connected') return 'Authenticated live event stream connected.';
    return typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? {});
  };

  const queueTotals = metrics?.queueMetrics?.reduce((totals, queue) => ({
    waiting: totals.waiting + queue.waiting,
    active: totals.active + queue.active,
    delayed: totals.delayed + queue.delayed,
    failed: totals.failed + queue.failed,
    oldestWaitingMs: queue.oldestWaitingMs === null ? totals.oldestWaitingMs : totals.oldestWaitingMs === null ? queue.oldestWaitingMs : Math.max(totals.oldestWaitingMs, queue.oldestWaitingMs),
  }), { waiting: 0, active: 0, delayed: 0, failed: 0, oldestWaitingMs: null as number | null });

  const oldestWaiting = queueTotals?.oldestWaitingMs === null || queueTotals?.oldestWaitingMs === undefined
    ? 'Unavailable'
    : `${Math.round(queueTotals.oldestWaitingMs / 1_000)}s`;

  return <div className="space-y-6">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"><div><h1 className="text-2xl font-bold text-white">Automation Control</h1><p className="text-xs text-slate-400">Manage persisted assisted-run state and monitor authenticated server events.</p></div><button onClick={onToggleAutomation} disabled={automationBusy} className={`px-5 py-2.5 rounded-xl font-bold text-xs flex gap-2 disabled:opacity-60 ${automationRunning ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'} text-white`}>{automationRunning ? <PauseCircle className="w-4 h-4" /> : <Play className="w-4 h-4" />}{automationRunning ? 'Pause run' : 'Start assisted run'}</button></div>
    <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 text-sm text-indigo-200 flex items-start gap-3"><Info className="w-5 h-5 shrink-0" /><p>Automation runs and browser attempts are persisted. Browser execution is limited to certified provider adapters, uses approved candidate data and exact documents, and pauses for CAPTCHA, MFA, authentication, or other human-verification requirements.</p></div>
    {metrics && <div className="grid grid-cols-2 lg:grid-cols-7 gap-3">{[['Waiting', queueTotals?.waiting ?? 'Unavailable'], ['Active', queueTotals?.active ?? 'Unavailable'], ['Delayed', queueTotals?.delayed ?? 'Unavailable'], ['Oldest wait', oldestWaiting], ['Failed', queueTotals?.failed ?? 'Unavailable'], ['Retries', metrics.retryMetrics.jobsWithRetries], ['Human review', metrics.pendingVerification.pendingCount]].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-3"><p className="text-[10px] uppercase text-slate-500">{label}</p><p className="mt-1 text-lg font-bold text-white">{value}</p></div>)}</div>}
    {metrics?.alerts?.length ? <section className="space-y-2">{metrics.alerts.map((alert) => <div key={alert.code} role="alert" className={`rounded-xl border p-3 text-xs ${alert.severity === 'CRITICAL' ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}><span className="font-bold">{alert.severity}: </span>{alert.message} <span className="opacity-75">({alert.value})</span></div>)}</section> : null}
    <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800 font-mono space-y-3 min-h-[420px] flex flex-col"><div className="flex items-center justify-between border-b border-slate-800 pb-3"><div className="flex gap-2 text-xs font-bold text-slate-300"><Terminal className="w-4 h-4 text-indigo-400" />Authenticated SSE event stream</div><span className={`text-[10px] ${streamState === 'connected' ? 'text-emerald-400' : 'text-amber-400'}`}>{streamState.toUpperCase()}</span></div>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <div className="flex-1 bg-black/60 rounded-xl p-4 overflow-y-auto space-y-2 text-[11px] text-slate-300 border border-slate-900">{events.length ? events.map((event, index) => <div key={event.id ?? `${event.timestamp}-${index}`}><span className="text-slate-500">[{new Date(event.timestamp).toLocaleTimeString()}]</span> <span className="text-indigo-300">[{event.type.toUpperCase()}]</span> {messageFor(event)}</div>) : <p className="text-slate-500">No automation events have been recorded. The stream remains connected for new events.</p>}</div>
    </div>
  </div>;
};
