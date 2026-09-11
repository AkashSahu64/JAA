import React, { useEffect, useState } from 'react';
import { Play, Terminal, PauseCircle, Info } from 'lucide-react';
import { fetchAutomationEvents, streamAutomationEvents } from '../services/api';
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

  useEffect(() => {
    const controller = new AbortController();
    void fetchAutomationEvents().then((data) => setEvents([...data].reverse())).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load events.'));
    void streamAutomationEvents((event) => {
      setStreamState('connected');
      setEvents((current) => [...current.slice(-199), event]);
    }, controller.signal).then(() => setStreamState('disconnected')).catch((cause) => {
      if (controller.signal.aborted) return;
      setStreamState('disconnected');
      setError(cause instanceof Error ? cause.message : 'Live stream disconnected.');
    });
    return () => controller.abort();
  }, []);

  const messageFor = (event: AutomationEvent) => {
    if (event.message) return event.message;
    if (event.type === 'connected') return 'Authenticated live event stream connected.';
    return typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? {});
  };

  return <div className="space-y-6">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"><div><h1 className="text-2xl font-bold text-white">Automation Control</h1><p className="text-xs text-slate-400">Manage persisted assisted-run state and monitor authenticated server events.</p></div><button onClick={onToggleAutomation} disabled={automationBusy} className={`px-5 py-2.5 rounded-xl font-bold text-xs flex gap-2 disabled:opacity-60 ${automationRunning ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'} text-white`}>{automationRunning ? <PauseCircle className="w-4 h-4" /> : <Play className="w-4 h-4" />}{automationRunning ? 'Pause run' : 'Start assisted run'}</button></div>
    <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 text-sm text-indigo-200 flex items-start gap-3"><Info className="w-5 h-5 shrink-0" /><p>The current backend stores run status and events only. It does not launch Playwright, fill employer forms, or automatically submit applications. Rate-limit and mode configuration controls are unavailable until corresponding API endpoints exist.</p></div>
    <div className="p-5 rounded-2xl bg-slate-950 border border-slate-800 font-mono space-y-3 min-h-[420px] flex flex-col"><div className="flex items-center justify-between border-b border-slate-800 pb-3"><div className="flex gap-2 text-xs font-bold text-slate-300"><Terminal className="w-4 h-4 text-indigo-400" />Authenticated SSE event stream</div><span className={`text-[10px] ${streamState === 'connected' ? 'text-emerald-400' : 'text-amber-400'}`}>{streamState.toUpperCase()}</span></div>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      <div className="flex-1 bg-black/60 rounded-xl p-4 overflow-y-auto space-y-2 text-[11px] text-slate-300 border border-slate-900">{events.length ? events.map((event, index) => <div key={event.id ?? `${event.timestamp}-${index}`}><span className="text-slate-500">[{new Date(event.timestamp).toLocaleTimeString()}]</span> <span className="text-indigo-300">[{event.type.toUpperCase()}]</span> {messageFor(event)}</div>) : <p className="text-slate-500">No automation events have been recorded. The stream remains connected for new events.</p>}</div>
    </div>
  </div>;
};
