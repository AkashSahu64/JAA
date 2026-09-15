import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { fetchHumanVerifications, resolveHumanVerification, UIHumanVerification } from '../services/api';

export const FailedAppsView: React.FC = () => {
  const [items, setItems] = useState<UIHumanVerification[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { void fetchHumanVerifications().then(setItems).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load verification requests.')); }, []);
  const resolve = async (item: UIHumanVerification) => {
    setBusy(item.id);
    try { await resolveHumanVerification(item.id); setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: 'RESOLVED', resolvedAt: new Date().toISOString() } : entry)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not acknowledge verification.'); }
    finally { setBusy(''); }
  };
  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold text-white">Human Review Room</h1><p className="text-xs text-slate-400">Durable verification requests from the authenticated API. CAPTCHA and MFA are completed by you; this interface never bypasses them.</p></div>
    {error && <p role="alert" className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm text-rose-300">{error}</p>}
    {!error && items.length === 0 && <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 text-center space-y-3"><AlertTriangle className="w-9 h-9 text-amber-400 mx-auto" /><p className="text-sm text-slate-400">No verification requests are currently recorded.</p></div>}
    <div className="space-y-3">{items.map((item) => <article key={item.id} className="p-5 rounded-2xl bg-slate-900 border border-slate-800"><div className="flex justify-between gap-3"><div><p className="text-xs font-mono text-indigo-300">{item.type}</p><h2 className="font-bold text-white mt-1">Application {item.applicationId}</h2></div><span className="text-xs text-slate-400">{item.status}</span></div><p className="text-sm text-slate-300 mt-3">{item.prompt}</p><p className="text-xs text-slate-500 mt-2">Expires: {new Date(item.expiresAt).toLocaleString()}</p>{item.status === 'PENDING' && <button type="button" disabled={busy === item.id} onClick={() => void resolve(item)} className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60">{busy === item.id ? 'Acknowledging…' : 'Acknowledge completion'}</button>}</article>)}</div>
  </div>;
};
