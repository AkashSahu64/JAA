import React, { FormEvent, useState } from 'react';
import { Bot, Loader2, LockKeyhole } from 'lucide-react';
import { AuthSession, login, register } from '../services/api';

interface AuthViewProps {
  onAuthenticated: (session: AuthSession) => void;
}

export const AuthView: React.FC<AuthViewProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = mode === 'login'
        ? await login(email, password)
        : await register(name, email, password);
      onAuthenticated(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
      <section className="w-full max-w-sm p-6 rounded-3xl bg-slate-900/80 border border-slate-800 shadow-2xl" aria-labelledby="auth-title">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-cyan-400 p-0.5">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center"><Bot className="w-6 h-6 text-indigo-300" /></div>
          </div>
          <div><h1 id="auth-title" className="text-lg font-bold text-white">JobAgent</h1><p className="text-xs text-slate-400">Sign in to access your workspace</p></div>
        </div>

        <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-950 border border-slate-800 mb-5" role="tablist" aria-label="Authentication mode">
          {(['login', 'register'] as const).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => { setMode(item); setError(''); }} className={`py-2 rounded-lg text-xs font-semibold capitalize ${mode === item ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>{item}</button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          {mode === 'register' && <label className="block text-xs font-semibold text-slate-300">Name<input required maxLength={200} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1.5 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none" /></label>}
          <label className="block text-xs font-semibold text-slate-300">Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1.5 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none" /></label>
          <label className="block text-xs font-semibold text-slate-300">Password<input required minLength={mode === 'register' ? 12 : 1} maxLength={1024} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1.5 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none" />{mode === 'register' && <span className="block mt-1 text-[10px] font-normal text-slate-500">Use at least 12 characters.</span>}</label>
          {error && <p role="alert" className="text-xs text-rose-300 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">{error}</p>}
          <button disabled={busy} className="w-full py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-60 text-white text-sm font-bold flex items-center justify-center gap-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LockKeyhole className="w-4 h-4" />}{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">Your access token is kept in this browser tab’s session storage and cleared when you sign out. Refresh tokens are not persisted.</p>
      </section>
    </main>
  );
};
