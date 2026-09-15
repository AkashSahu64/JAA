import React, { FormEvent, useEffect, useState } from 'react';
import { Plus, Settings, ShieldCheck, Trash2 } from 'lucide-react';
import { createRule, createSearchProfile, deleteRule, deleteSearchProfile, fetchEmailConnections, fetchRules, fetchSearchProfiles, revokeEmailConnection, setSearchProfileActive, UIRule } from '../services/api';
import { UIEmailConnection, UISearchProfile } from '../types';

export const SettingsView: React.FC = () => {
  const [rules, setRules] = useState<UIRule[]>([]);
  const [name, setName] = useState('');
  const [action, setAction] = useState<UIRule['action']>('REVIEW');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [profiles, setProfiles] = useState<UISearchProfile[]>([]);
  const [profileBusy, setProfileBusy] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileRole, setProfileRole] = useState('');
  const [profileCity, setProfileCity] = useState('');
  const [profileAccount, setProfileAccount] = useState('');
  const [profileSource, setProfileSource] = useState<'GREENHOUSE' | 'LEVER' | 'ASHBY'>('GREENHOUSE');
  const [profileSchedule, setProfileSchedule] = useState('DAILY');
  const [profileCustomCron, setProfileCustomCron] = useState('');
  const [profileTimeZone, setProfileTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [profileDailyLimit, setProfileDailyLimit] = useState('50');
  const [emailConnections, setEmailConnections] = useState<UIEmailConnection[]>([]);
  const [emailBusy, setEmailBusy] = useState<string | null>(null);

  const load = () => fetchRules().then(setRules).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load rules.'));
  useEffect(() => {
    void load();
    void fetchSearchProfiles().then(setProfiles).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load search profiles.'));
    void fetchEmailConnections().then(setEmailConnections).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load email connections.'));
  }, []);
  const toggleProfile = async (profile: UISearchProfile) => {
    setProfileBusy(profile.id); setError('');
    try { const updated = await setSearchProfileActive(profile.id, !profile.isActive); setProfiles((current) => current.map((item) => item.id === updated.id ? updated : item)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update search profile schedule.'); }
    finally { setProfileBusy(null); }
  };
  const removeProfile = async (profile: UISearchProfile) => {
    setProfileBusy(profile.id); setError('');
    try { await deleteSearchProfile(profile.id); setProfiles((current) => current.filter((item) => item.id !== profile.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel search profile schedule.'); }
    finally { setProfileBusy(null); }
  };
  const addProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!profileName.trim() || !profileRole.trim() || !profileAccount.trim() || (profileSchedule === 'CUSTOM' && !profileCustomCron.trim())) return;
    setProfileBusy('new'); setError('');
    try {
      const profile = await createSearchProfile({ name: profileName.trim(), targetRoles: [profileRole.trim()], cities: profileCity.trim() ? [profileCity.trim()] : [], schedule: profileSchedule, ...(profileSchedule === 'CUSTOM' ? { customCron: profileCustomCron.trim() } : {}), timeZone: profileTimeZone.trim(), maxApplicationsPerDay: Number(profileDailyLimit), discoveryAccounts: [{ source: profileSource, account: profileAccount.trim() }] });
      setProfiles((current) => [profile, ...current]); setProfileName(''); setProfileRole(''); setProfileCity(''); setProfileAccount(''); setProfileCustomCron(''); setProfileDailyLimit('50');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create search profile.'); }
    finally { setProfileBusy(null); }
  };
  const addRule = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try { const rule = await createRule({ name: name.trim(), conditions: [], action, priority: 0 }); setRules((current) => [rule, ...current]); setName(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create rule.'); }
    finally { setBusy(false); }
  };
  const removeRule = async (id: string) => {
    setBusy(true); setError('');
    try { await deleteRule(id); setRules((current) => current.filter((rule) => rule.id !== id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete rule.'); }
    finally { setBusy(false); }
  };
  const revokeConnection = async (connection: UIEmailConnection) => {
    setEmailBusy(connection.id); setError('');
    try { await revokeEmailConnection(connection.id); setEmailConnections((current) => current.map((item) => item.id === connection.id ? { ...item, status: 'REVOKED', revokedAt: new Date().toISOString() } : item)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not revoke email consent.'); }
    finally { setEmailBusy(null); }
  };

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold text-white">Rules & Security</h1><p className="text-xs text-slate-400">Manage persisted decision rules and review deployment security boundaries.</p></div>
    {error && <p role="alert" className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</p>}
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      <h2 className="font-bold text-sm text-white flex gap-2"><Settings className="w-4 h-4 text-indigo-400" />Decision rules</h2>
      <form onSubmit={addRule} className="grid sm:grid-cols-[1fr_10rem_auto] gap-2"><input required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} placeholder="Rule name" aria-label="Rule name" className="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white" /><select value={action} onChange={(event) => setAction(event.target.value as UIRule['action'])} aria-label="Rule action" className="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white"><option value="REVIEW">Review</option><option value="APPLY">Apply</option><option value="SKIP">Skip</option><option value="NOTIFY">Notify</option></select><button disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white flex items-center justify-center gap-1 disabled:opacity-60"><Plus className="w-3.5 h-3.5" />Add</button></form>
      {rules.length === 0 ? <p className="text-xs text-slate-500">No rules configured. Conditions can be added through the API until a structured condition editor is available.</p> : <div className="space-y-2">{rules.map((rule) => <div key={rule.id} className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3"><div><p className="font-bold text-sm text-white">{rule.name}</p><p className="text-[11px] text-slate-500">{rule.conditions.length} condition(s) · priority {rule.priority} · {rule.enabled ? 'enabled' : 'disabled'}</p></div><div className="flex items-center gap-2"><span className="px-2 py-1 rounded bg-indigo-500/15 text-indigo-300 text-[10px] font-mono">{rule.action}</span><button type="button" disabled={busy} onClick={() => void removeRule(rule.id)} aria-label={`Delete ${rule.name}`} className="p-2 rounded-lg text-slate-400 hover:text-rose-300 disabled:opacity-60"><Trash2 className="w-4 h-4" /></button></div></div>)}</div>}
    </section>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3"><h2 className="font-bold text-sm text-white flex gap-2"><ShieldCheck className="w-4 h-4 text-emerald-400" />Credential boundaries</h2><p className="text-sm text-slate-400">AI and encryption secrets are server environment variables and are never returned to this browser. The credential-vault library is process-local and is not exposed as durable account storage. Configure production secrets through your deployment platform.</p></section>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4"><h2 className="font-bold text-sm text-white">Email consent</h2><p className="text-xs text-slate-400">Mailbox consent is shown from durable backend state. OAuth authorization and provider token exchange are not available here, so this screen never asks the browser to handle credentials.</p>{emailConnections.length === 0 ? <p className="text-xs text-slate-500">No email connections granted.</p> : <div className="space-y-2">{emailConnections.map((connection) => <div key={connection.id} className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3"><div><p className="font-bold text-sm text-white">{connection.provider} · {connection.accountLabel}</p><p className="text-[11px] text-slate-500">{connection.status} · {connection.scopes.join(', ') || 'No scopes'}{connection.lastSyncAt ? ` · Last sync ${new Date(connection.lastSyncAt).toLocaleString()}` : ''}</p></div>{connection.status === 'ACTIVE' && <button type="button" disabled={emailBusy === connection.id} onClick={() => void revokeConnection(connection)} className="rounded-lg bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{emailBusy === connection.id ? 'Revoking…' : 'Revoke'}</button>}</div>)}</div>}</section>
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      <h2 className="font-bold text-sm text-white">Durable discovery schedules</h2>
      <form onSubmit={addProfile} className="grid sm:grid-cols-2 gap-2">
        <input required maxLength={200} value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" aria-label="Search profile name" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white" />
        <input required maxLength={200} value={profileRole} onChange={(event) => setProfileRole(event.target.value)} placeholder="Target role" aria-label="Target role" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white" />
        <input maxLength={200} value={profileCity} onChange={(event) => setProfileCity(event.target.value)} placeholder="City (optional)" aria-label="Search city" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white" />
        <input required maxLength={200} value={profileAccount} onChange={(event) => setProfileAccount(event.target.value)} placeholder="Provider account/board" aria-label="Provider account" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white" />
        <select value={profileSource} onChange={(event) => setProfileSource(event.target.value as typeof profileSource)} aria-label="Discovery provider" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white"><option value="GREENHOUSE">Greenhouse</option><option value="LEVER">Lever</option><option value="ASHBY">Ashby</option></select>
        <select value={profileSchedule} onChange={(event) => setProfileSchedule(event.target.value)} aria-label="Discovery schedule" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white"><option value="DAILY">Daily</option><option value="EVERY_3_HOURS">Every 3 hours</option><option value="HOURLY">Hourly</option><option value="WEEKLY">Weekly</option><option value="ONCE">Once</option><option value="CUSTOM">Custom cron</option></select>
        <input required maxLength={100} value={profileTimeZone} onChange={(event) => setProfileTimeZone(event.target.value)} placeholder="America/New_York" aria-label="Schedule timezone" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white sm:col-span-2" />
        <input required type="number" min={0} max={10000} step={1} value={profileDailyLimit} onChange={(event) => setProfileDailyLimit(event.target.value)} placeholder="50" aria-label="Daily application limit" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white" />
        {profileSchedule === 'CUSTOM' && <input required maxLength={100} value={profileCustomCron} onChange={(event) => setProfileCustomCron(event.target.value)} placeholder="30 9 * * 1-5" aria-label="Custom cron expression" className="rounded-lg bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-white sm:col-span-2" />}
        <button type="submit" disabled={profileBusy !== null} className="sm:col-span-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{profileBusy === 'new' ? 'Creating…' : 'Create search profile'}</button>
      </form>
      {profiles.length ? <div className="space-y-2">{profiles.map((profile) => <div key={profile.id} className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3"><div><p className="font-bold text-sm text-white">{profile.name}</p><p className="text-[11px] text-slate-500">{profile.schedule} · {profile.isActive ? `Next: ${profile.nextRunAt ? new Date(profile.nextRunAt).toLocaleString() : 'pending'}` : 'paused'}</p><p className="text-[10px] text-slate-600">{profile.timeZone ?? 'UTC'} · {profile.maxApplicationsPerDay ?? 50} applications/day</p></div><div className="flex gap-2"><button type="button" disabled={profileBusy === profile.id} onClick={() => void toggleProfile(profile)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{profileBusy === profile.id ? 'Updating…' : profile.isActive ? 'Pause' : 'Resume'}</button><button type="button" disabled={profileBusy === profile.id} onClick={() => void removeProfile(profile)} aria-label={`Cancel ${profile.name} schedule`} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 disabled:opacity-50"><Trash2 className="w-4 h-4" /></button></div></div>)}</div> : <p className="text-xs text-slate-500">No persisted search profiles are configured.</p>}
    </section>
  </div>;
};
