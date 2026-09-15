import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, CheckCircle2, AlertCircle, MapPin, DollarSign, ExternalLink, RefreshCw } from 'lucide-react';
import { discoverJobs, fetchDiscoveryRuns, fetchJobs } from '../services/api';
import { DiscoveryRunStatus, DiscoveryRunSummary, UIJob } from '../types';

const ACTIVE_RUN_STATUSES: DiscoveryRunStatus[] = ['PENDING', 'RUNNING'];

export const JobsView: React.FC = () => {
  const [jobs, setJobs] = useState<UIJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<UIJob | null>(null);
  const [runs, setRuns] = useState<DiscoveryRunSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [tierFilter, setTierFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [greenhouseBoards, setGreenhouseBoards] = useState('');
  const [leverCompanies, setLeverCompanies] = useState('');
  const [ashbyBoards, setAshbyBoards] = useState('');
  const [location, setLocation] = useState('');
  const [jobError, setJobError] = useState('');
  const [runError, setRunError] = useState('');
  const jobsRequest = useRef<AbortController | null>(null);
  const runsRequest = useRef<AbortController | null>(null);

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    const controller = signal ? null : new AbortController();
    if (controller) {
      jobsRequest.current?.abort();
      jobsRequest.current = controller;
    }
    const requestSignal = signal ?? controller!.signal;
    setLoading(true);
    setJobError('');
    try {
      const data = await fetchJobs(searchQuery, requestSignal);
      if (requestSignal.aborted) return;
      setJobs(data);
      setSelectedJob((current) => data.find((job) => job.id === current?.id) ?? data[0] ?? null);
    } catch (cause) {
      if (requestSignal.aborted) return;
      setJobError(cause instanceof Error ? cause.message : 'Could not load jobs.');
    } finally {
      if (!requestSignal.aborted) setLoading(false);
      if (controller && jobsRequest.current === controller) jobsRequest.current = null;
    }
  }, [searchQuery]);

  const loadRuns = useCallback(async (quiet = false, signal?: AbortSignal) => {
    const controller = signal ? null : new AbortController();
    if (controller) {
      runsRequest.current?.abort();
      runsRequest.current = controller;
    }
    const requestSignal = signal ?? controller!.signal;
    if (!quiet) setRunsLoading(true);
    setRunError('');
    try {
      const nextRuns = await fetchDiscoveryRuns(20, requestSignal);
      if (!requestSignal.aborted) setRuns(nextRuns);
    } catch (cause) {
      if (!requestSignal.aborted) setRunError(cause instanceof Error ? cause.message : 'Could not load discovery runs.');
    } finally {
      if (!quiet && !requestSignal.aborted) setRunsLoading(false);
      if (controller && runsRequest.current === controller) runsRequest.current = null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setJobError('');
      void fetchJobs(searchQuery, controller.signal).then((data) => {
        if (controller.signal.aborted) return;
        setJobs(data);
        setSelectedJob((current) => data.find((job) => job.id === current?.id) ?? data[0] ?? null);
      }).catch((cause) => {
        if (!controller.signal.aborted) setJobError(cause instanceof Error ? cause.message : 'Could not load jobs.');
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  useEffect(() => {
    const controller = new AbortController();
    void loadRuns(false, controller.signal);
    return () => controller.abort();
  }, [loadRuns]);

  useEffect(() => () => {
    jobsRequest.current?.abort();
    runsRequest.current?.abort();
  }, []);

  const hasActiveRun = runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status));
  useEffect(() => {
    if (!hasActiveRun) return undefined;
    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        const [nextRuns, nextJobs] = await Promise.all([
          fetchDiscoveryRuns(20, controller.signal),
          fetchJobs(searchQuery, controller.signal),
        ]);
        if (stopped || controller.signal.aborted) return;
        setRuns(nextRuns);
        setJobs(nextJobs);
        setSelectedJob((current) => nextJobs.find((job) => job.id === current?.id) ?? nextJobs[0] ?? null);
        setRunError('');
        setJobError('');
      } catch (cause) {
        if (stopped || controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : 'Could not refresh discovery progress.';
        setRunError(message);
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 5000);
    };
    timer = window.setTimeout(() => void poll(), 5000);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [hasActiveRun, searchQuery]);

  const filteredJobs = useMemo(() => jobs.filter((job) => tierFilter === 'ALL' || job.tier === tierFilter), [jobs, tierFilter]);
  const parseSlugs = (value: string) => {
    const values = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
    return { values, invalid: values.filter((item) => !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(item)) };
  };
  const runDiscovery = async () => {
    const greenhouse = parseSlugs(greenhouseBoards);
    const lever = parseSlugs(leverCompanies);
    const ashby = parseSlugs(ashbyBoards);
    const accounts = [...greenhouse.values, ...lever.values, ...ashby.values];
    const invalid = [...greenhouse.invalid, ...lever.invalid, ...ashby.invalid];
    if (accounts.length === 0) {
      setRunError('Enter at least one Greenhouse, Lever, or Ashby account slug.');
      return;
    }
    if (invalid.length > 0) {
      setRunError(`Use account slugs only (letters, numbers, hyphens, and underscores). Invalid: ${invalid.join(', ')}`);
      return;
    }
    if (greenhouse.values.length > 20 || lever.values.length > 20 || ashby.values.length > 20) {
      setRunError('Enter no more than 20 accounts for each provider.');
      return;
    }
    setDiscovering(true);
    setRunError('');
    try {
      const { runs: startedRuns } = await discoverJobs({
        greenhouseBoards: greenhouse.values,
        leverCompanies: lever.values,
        ashbyBoards: ashby.values,
        query: searchQuery.trim() || undefined,
        location: location.trim() || undefined,
      });
      setRuns((current) => [
        ...startedRuns,
        ...current.filter((item) => !startedRuns.some((started) => started.id === item.id)),
      ]);
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : 'Could not start discovery.');
    } finally {
      setDiscovering(false);
    }
  };
  const refreshAll = async () => { await Promise.all([loadJobs(), loadRuns()]); };
  const scoreLabel = (score?: number) => score === undefined ? 'Not scored' : `${Math.round(score)}% Match`;
  const dateLabel = (date?: string) => date ? new Date(date).toLocaleDateString() : 'Date unavailable';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div><h1 className="text-2xl font-bold text-white tracking-tight">Discovered Jobs</h1><p className="text-xs text-slate-400">Authenticated results from Greenhouse, Lever, and Ashby discovery.</p></div>
        <div className="flex items-center gap-3">
          <div className="relative w-64"><Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} aria-label="Search jobs" placeholder="Search title or company…" className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500" /></div>
          <select value={tierFilter} onChange={(event) => setTierFilter(event.target.value)} aria-label="Filter by match tier" className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300"><option value="ALL">All match tiers</option><option value="EXCELLENT">Excellent</option><option value="STRONG">Strong</option><option value="MODERATE">Moderate</option><option value="WEAK">Weak</option></select>
        </div>
      </div>

      <section className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3" aria-labelledby="discovery-heading">
        <div className="flex items-start justify-between gap-3"><div><h2 id="discovery-heading" className="text-sm font-bold text-white">Run ATS discovery</h2><p className="text-[11px] text-slate-500">Enter public board or company slugs, separated by commas. Starting a run does not mean it has completed.</p></div><button type="button" disabled={runsLoading} onClick={() => void refreshAll()} className="text-xs text-slate-300 hover:text-white disabled:opacity-50 flex items-center gap-1"><RefreshCw className={`w-3.5 h-3.5 ${runsLoading ? 'animate-spin' : ''}`} />Refresh</button></div>
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-2"><DiscoveryInput label="Greenhouse board slugs" value={greenhouseBoards} onChange={setGreenhouseBoards} placeholder="acme-invalid" /><DiscoveryInput label="Lever company slugs" value={leverCompanies} onChange={setLeverCompanies} placeholder="acme-invalid" /><DiscoveryInput label="Ashby board slugs" value={ashbyBoards} onChange={setAshbyBoards} placeholder="acme-invalid" /><DiscoveryInput label="Discovery location" value={location} onChange={setLocation} placeholder="Remote" /></div>
        <button type="button" disabled={discovering} onClick={() => void runDiscovery()} className="rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white flex items-center justify-center gap-2"><RefreshCw className={`w-3.5 h-3.5 ${discovering ? 'animate-spin' : ''}`} />{discovering ? 'Starting…' : 'Start discovery'}</button>
        {runError && <p role="alert" className="text-xs text-rose-300">{runError}</p>}
        <DiscoveryRunList runs={runs} loading={runsLoading} />
      </section>

      {loading && <StateCard text="Loading jobs…" />}
      {!loading && jobError && <StateCard text={jobError} error />}
      {!loading && !jobError && filteredJobs.length === 0 && <StateCard text={searchQuery ? 'No jobs match this search.' : 'No jobs have been discovered yet. Configure a public ATS account above to import listings.'} />}
      {!loading && !jobError && filteredJobs.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 space-y-3">{filteredJobs.map((job) => <button type="button" key={job.id} onClick={() => setSelectedJob(job)} aria-pressed={selectedJob?.id === job.id} className={`w-full p-4 rounded-2xl border text-left transition-all ${selectedJob?.id === job.id ? 'bg-slate-900 border-indigo-500/60' : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'}`}>
          <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><span className="font-semibold text-xs text-slate-400">{job.company}</span><span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">{job.source}</span></div><h3 className="font-bold text-base text-white mt-1">{job.title}</h3></div><div className="text-right"><span className="px-2.5 py-1 rounded-xl text-xs font-mono font-bold border bg-indigo-500/10 text-indigo-300 border-indigo-500/30">{scoreLabel(job.matchScore)}</span><span className="text-[10px] text-slate-500 block mt-1">{dateLabel(job.postedAt)}</span></div></div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-300"><span className="flex gap-1"><MapPin className="w-3.5 h-3.5" />{job.location}{job.remoteType ? ` (${job.remoteType})` : ''}</span><span className="flex gap-1 font-mono text-emerald-400"><DollarSign className="w-3.5 h-3.5" />{job.salary}</span></div>
          <div className="mt-3 flex flex-wrap gap-1.5">{job.tags.map((tag) => <span key={tag} className="px-2 py-0.5 rounded-md bg-slate-800/80 text-[11px] font-mono text-slate-300">{tag}</span>)}</div>
        </button>)}</div>

        <div className="lg:col-span-5">{selectedJob && <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-5 sticky top-24">
          <div className="space-y-2 border-b border-slate-800 pb-4"><div className="flex justify-between"><span className="text-xs font-semibold text-indigo-400">{selectedJob.company}</span>{selectedJob.sourceUrl && <a href={selectedJob.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-slate-400 hover:text-white flex gap-1">Source <ExternalLink className="w-3 h-3" /></a>}</div><h2 className="font-bold text-lg text-white">{selectedJob.title}</h2><p className="text-xs text-slate-400">{selectedJob.description}</p></div>
          {selectedJob.applicationStatus ? <div className="py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs text-center">Application status: {selectedJob.applicationStatus}</div> : selectedJob.applicationUrl ? <a href={selectedJob.applicationUrl} target="_blank" rel="noreferrer" className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex justify-center gap-2">Open employer application <ExternalLink className="w-4 h-4" /></a> : <div className="py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 text-xs text-center">Application link unavailable. A certified provider workflow is required.</div>}
          <div className="space-y-3"><h4 className="text-xs font-bold text-slate-300 uppercase font-mono">Qualifications</h4>{selectedJob.mustHave.length ? <ul className="space-y-1.5 text-xs text-slate-300">{selectedJob.mustHave.map((item) => <li key={item} className="flex gap-2"><CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />{item}</li>)}</ul> : <p className="text-xs text-slate-500">No structured qualification analysis is available.</p>}</div>
          {selectedJob.redFlags.length > 0 && <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300"><div className="font-semibold flex gap-1"><AlertCircle className="w-4 h-4" />Analysis signals</div>{selectedJob.redFlags.map((flag) => <p key={flag}>• {flag}</p>)}</div>}
        </div>}</div>
      </div>}
    </div>
  );
};

const DiscoveryInput = ({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) => <input value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} placeholder={placeholder} className="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white" />;

const DiscoveryRunList = ({ runs, loading }: { runs: DiscoveryRunSummary[]; loading: boolean }) => {
  if (loading) return <p role="status" className="text-xs text-slate-400">Loading durable discovery runs…</p>;
  if (runs.length === 0) return <p className="text-xs text-slate-500">No discovery runs have been started.</p>;
  return <div className="space-y-2" aria-live="polite">{runs.map((run) => <DiscoveryRunRow key={run.id} run={run} />)}</div>;
};

const DiscoveryRunRow = ({ run }: { run: DiscoveryRunSummary }) => {
  const completed = run.status === 'SUCCEEDED';
  const failed = run.status === 'FAILED' || run.status === 'PARTIAL' || run.status === 'UNKNOWN';
  const cancelled = run.status === 'CANCELLED';
  const sourceLabel = run.sources.length ? run.sources.map((source) => `${source.provider}: ${source.account}`).join(', ') : 'Sources unavailable';
  const timestamp = run.completedAt ?? run.startedAt ?? run.createdAt;
  const feedback = run.errorMessage
    ?? (run.status === 'PARTIAL' ? 'Discovery completed with some items rejected or unavailable.'
      : run.status === 'FAILED' ? 'Discovery failed before jobs could be saved.'
        : cancelled ? 'Discovery was cancelled before completion.'
          : run.status === 'UNKNOWN' ? 'The server returned an unrecognized run status.' : undefined);
  return <article className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-slate-200">{sourceLabel}</p><span className={`rounded-md border px-2 py-0.5 font-mono ${completed ? 'border-emerald-500/30 text-emerald-300' : failed ? 'border-rose-500/30 text-rose-300' : cancelled ? 'border-amber-500/30 text-amber-300' : 'border-indigo-500/30 text-indigo-300'}`}>{run.status}</span></div>
    <p className="mt-1 text-[11px] text-slate-500">{new Date(timestamp).toLocaleString()}{run.query ? ` · ${run.query}` : ''}{run.location ? ` · ${run.location}` : ''}</p>
    {run.automationJobId && <p className="mt-1 text-[10px] text-slate-600 font-mono" title={run.automationJobId}>Automation job {run.automationJobId}</p>}
    <div className="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2 text-slate-400"><RunCount label="Discovered" value={run.discoveredCount} /><RunCount label="Normalized" value={run.normalizedCount} /><RunCount label="Duplicates" value={run.duplicateCount} /><RunCount label="Saved" value={run.savedCount} /><RunCount label="Failed" value={run.failedCount} /></div>
    {feedback && <p role={failed ? 'alert' : undefined} className={`mt-2 ${failed ? 'text-rose-300' : 'text-amber-300'}`}>{run.errorClass ? `${run.errorClass}${run.errorCode ? ` (${run.errorCode})` : ''}: ` : ''}{feedback}{run.errorRetryable ? ' The service may retry this run.' : ''}</p>}
  </article>;
};

const RunCount = ({ label, value }: { label: string; value: number }) => <span><span className="block text-[10px] uppercase text-slate-600">{label}</span><strong className="font-mono text-slate-300">{value}</strong></span>;
const StateCard = ({ text, error = false }: { text: string; error?: boolean }) => <div role={error ? 'alert' : 'status'} className={`p-8 rounded-2xl border bg-slate-900/60 text-center text-sm ${error ? 'border-rose-500/30 text-rose-300' : 'border-slate-800 text-slate-400'}`}>{text}</div>;
