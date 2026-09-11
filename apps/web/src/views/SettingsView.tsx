import React, { FormEvent, useEffect, useState } from 'react';
import { Plus, Settings, ShieldCheck, Trash2 } from 'lucide-react';
import { createRule, deleteRule, fetchRules, UIRule } from '../services/api';

export const SettingsView: React.FC = () => {
  const [rules, setRules] = useState<UIRule[]>([]);
  const [name, setName] = useState('');
  const [action, setAction] = useState<UIRule['action']>('REVIEW');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => fetchRules().then(setRules).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load rules.'));
  useEffect(() => { void load(); }, []);

  const addRule = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const rule = await createRule({ name: name.trim(), conditions: [], action, priority: 0 });
      setRules((current) => [rule, ...current]);
      setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create rule.');
    } finally { setBusy(false); }
  };

  const removeRule = async (id: string) => {
    setBusy(true); setError('');
    try { await deleteRule(id); setRules((current) => current.filter((rule) => rule.id !== id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete rule.'); }
    finally { setBusy(false); }
  };

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold text-white">Rules & Security</h1><p className="text-xs text-slate-400">Manage persisted decision rules and review deployment security boundaries.</p></div>
    {error && <p role="alert" className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</p>}
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      <h2 className="font-bold text-sm text-white flex gap-2"><Settings className="w-4 h-4 text-indigo-400" />Decision rules</h2>
      <form onSubmit={addRule} className="grid sm:grid-cols-[1fr_10rem_auto] gap-2"><input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rule name" aria-label="Rule name" className="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white" /><select value={action} onChange={(e) => setAction(e.target.value as UIRule['action'])} aria-label="Rule action" className="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white"><option value="REVIEW">Review</option><option value="APPLY">Apply</option><option value="SKIP">Skip</option><option value="NOTIFY">Notify</option></select><button disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white flex items-center justify-center gap-1 disabled:opacity-60"><Plus className="w-3.5 h-3.5" />Add</button></form>
      {rules.length === 0 ? <p className="text-xs text-slate-500">No rules configured. Conditions can be added through the API until a structured condition editor is available.</p> : <div className="space-y-2">{rules.map((rule) => <div key={rule.id} className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3"><div><p className="font-bold text-sm text-white">{rule.name}</p><p className="text-[11px] text-slate-500">{rule.conditions.length} condition(s) · priority {rule.priority} · {rule.enabled ? 'enabled' : 'disabled'}</p></div><div className="flex items-center gap-2"><span className="px-2 py-1 rounded bg-indigo-500/15 text-indigo-300 text-[10px] font-mono">{rule.action}</span><button type="button" disabled={busy} onClick={() => void removeRule(rule.id)} aria-label={`Delete ${rule.name}`} className="p-2 rounded-lg text-slate-400 hover:text-rose-300 disabled:opacity-60"><Trash2 className="w-4 h-4" /></button></div></div>)}</div>}
    </section>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3"><h2 className="font-bold text-sm text-white flex gap-2"><ShieldCheck className="w-4 h-4 text-emerald-400" />Credential boundaries</h2><p className="text-sm text-slate-400">AI and encryption secrets are server environment variables and are never returned to this browser. The credential-vault library is process-local and is not exposed as durable account storage. Configure production secrets through your deployment platform.</p></section>
  </div>;
};
