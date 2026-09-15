import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { applyEmailOutcome, authorizeSubmission, cancelAutomationJob, decideOffer, fetchApplication, fetchApplications, recordInterview, recordOffer, reviewEmailOutcome, scheduleApplicationRun } from '../services/api';
import { UIApplication } from '../types';

export const ApplicationsView: React.FC = () => {
  const [apps, setApps] = useState<UIApplication[]>([]);
  const [selectedApp, setSelectedApp] = useState<UIApplication | null>(null);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [offerBusyId, setOfferBusyId] = useState<string | null>(null);
  const [emailBusyId, setEmailBusyId] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState<'INTERVIEW' | 'OFFER' | null>(null);
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const [interviewType, setInterviewType] = useState('');
  const [interviewDate, setInterviewDate] = useState('');
  const [offerSalary, setOfferSalary] = useState('');
  const [offerCurrency, setOfferCurrency] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    void fetchApplications().then((data) => {
      setApps(data);
      setSelectedApp(data[0] ?? null);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load applications.')).finally(() => setLoading(false));
  }, []);

  const selectApp = (app: UIApplication) => {
    setSelectedApp(app);
    setDetailLoading(true);
    void fetchApplication(app.id).then(setSelectedApp).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load application details.')).finally(() => setDetailLoading(false));
  };
  const applyOfferDecision = async (offerId: string, decision: 'ACCEPTED' | 'DECLINED') => {
    if (!selectedApp) return;
    setOfferBusyId(offerId);
    setError('');
    try {
      await decideOffer(selectedApp.id, offerId, decision);
      const refreshed = await fetchApplication(selectedApp.id);
      setSelectedApp(refreshed);
      setApps((current) => current.map((app) => app.id === refreshed.id ? { ...app, status: refreshed.status } : app));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not decide offer.');
    } finally {
      setOfferBusyId(null);
    }
  };
  const applyReviewedEmailOutcome = async (outcomeId: string) => {
    if (!selectedApp?.version) return;
    setEmailBusyId(outcomeId);
    setError('');
    try {
      const refreshed = await applyEmailOutcome(outcomeId, selectedApp.version, `dashboard-email-outcome:${outcomeId}`);
      setSelectedApp(refreshed);
      setApps((current) => current.map((app) => app.id === refreshed.id ? { ...app, status: refreshed.status, version: refreshed.version } : app));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not apply email outcome. Refresh and review the application again.');
    } finally {
      setEmailBusyId(null);
    }
  };
  const reviewSelectedEmailOutcome = async (outcomeId: string) => {
    if (!selectedApp) return;
    setEmailBusyId(outcomeId);
    setError('');
    try {
      await reviewEmailOutcome(outcomeId);
      await refreshSelectedApplication();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record explicit email review.');
    } finally {
      setEmailBusyId(null);
    }
  };
  const refreshSelectedApplication = async () => {
    if (!selectedApp) return;
    const refreshed = await fetchApplication(selectedApp.id);
    setSelectedApp(refreshed);
    setApps((current) => current.map((app) => app.id === refreshed.id ? { ...app, status: refreshed.status, version: refreshed.version } : app));
  };
  const submitInterview = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedApp || !interviewType.trim()) return;
    setLifecycleBusy('INTERVIEW');
    setError('');
    try {
      await recordInterview(selectedApp.id, { type: interviewType.trim(), company: selectedApp.company, role: selectedApp.role, ...(interviewDate ? { date: new Date(interviewDate).toISOString() } : {}) });
      setInterviewType('');
      setInterviewDate('');
      await refreshSelectedApplication();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record interview.'); }
    finally { setLifecycleBusy(null); }
  };
  const submitOffer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedApp) return;
    const salary = offerSalary.trim() ? Number(offerSalary) : undefined;
    if (salary !== undefined && (!Number.isFinite(salary) || salary < 0)) { setError('Offer compensation must be a non-negative number.'); return; }
    setLifecycleBusy('OFFER');
    setError('');
    try {
      await recordOffer(selectedApp.id, { company: selectedApp.company, role: selectedApp.role, ...(salary === undefined ? {} : { salaryOffered: salary }), ...(offerCurrency.trim() ? { currency: offerCurrency.trim() } : {}) });
      setOfferSalary('');
      setOfferCurrency('');
      await refreshSelectedApplication();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record offer.'); }
    finally { setLifecycleBusy(null); }
  };
  const authorizeSelectedSubmission = async () => {
    if (!selectedApp?.version) return;
    setSubmissionBusy(true);
    setError('');
    try {
      await authorizeSubmission(selectedApp.id, selectedApp.version, `dashboard-submission:${selectedApp.id}`);
      await refreshSelectedApplication();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not authorize submission.'); }
    finally { setSubmissionBusy(false); }
  };
  const scheduleSelectedRun = async () => {
    if (!selectedApp || !scheduleDate) return;
    setScheduleBusy(true);
    setError('');
    try {
      await scheduleApplicationRun(selectedApp.id, new Date(scheduleDate).toISOString());
      setScheduleDate('');
      await refreshSelectedApplication();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not schedule application run.'); }
    finally { setScheduleBusy(false); }
  };
  const cancelSelectedRun = async (jobId: string) => {
    setCancelBusyId(jobId);
    setError('');
    try { await cancelAutomationJob(jobId); await refreshSelectedApplication(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel scheduled application run.'); }
    finally { setCancelBusyId(null); }
  };
  const filteredApps = useMemo(() => apps.filter((app) => statusFilter === 'ALL' || app.status === statusFilter), [apps, statusFilter]);
  const statuses = [...new Set(apps.map((app) => app.status))];
  const date = (value?: string) => value ? new Date(value).toLocaleString() : 'Not submitted';
  const safeMeetingUrl = (value?: string) => {
    if (!value) return undefined;
    try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
  };

  return <div className="space-y-6">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"><div><h1 className="text-2xl font-bold text-white">Application Queue & Tracker</h1><p className="text-xs text-slate-400">Stored application records and attempt metadata from the authenticated API.</p></div><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter applications by status" className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300"><option value="ALL">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{status.split('_').join(' ')}</option>)}</select></div>
    {loading && <State text="Loading applications…" />}
    {!loading && error && <State text={error} error />}
    {!loading && !error && filteredApps.length === 0 && <State text={apps.length ? 'No applications have this status.' : 'No application records yet. Records appear when created by an integrated, certified provider workflow.'} />}
    {!loading && !error && filteredApps.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-7 space-y-3">{filteredApps.map((app) => <button type="button" key={app.id} onClick={() => selectApp(app)} aria-pressed={selectedApp?.id === app.id} className={`w-full p-4 rounded-2xl border text-left ${selectedApp?.id === app.id ? 'bg-slate-900 border-indigo-500/60' : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'}`}><div className="flex justify-between gap-3"><div><span className="font-semibold text-xs text-indigo-400">{app.company}</span><h3 className="font-bold text-base text-white">{app.role}</h3><p className="text-[11px] text-slate-400 font-mono">Applied: {date(app.appliedAt)}</p></div><div className="text-right"><StatusBadge status={app.status} /><p className="mt-2 text-[10px] text-slate-400 font-mono">Match: {app.matchScore === undefined ? '—' : `${Math.round(app.matchScore)}%`} · ATS: {app.atsScore === undefined ? '—' : `${Math.round(app.atsScore)}%`}</p></div></div></button>)}</div>
      <div className="lg:col-span-5">{selectedApp && <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-5 sticky top-24"><div className="space-y-1 border-b border-slate-800 pb-4"><div className="flex justify-between"><span className="text-xs font-semibold text-indigo-400">{selectedApp.company}</span><StatusBadge status={selectedApp.status} /></div><h2 className="font-bold text-lg text-white">{selectedApp.role}</h2>{selectedApp.location && <p className="text-xs text-slate-400">{selectedApp.location}</p>}</div>
        {selectedApp.failureReason && <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300"><div className="font-semibold flex gap-1"><AlertTriangle className="w-4 h-4" />Failure details</div><p>{selectedApp.failureReason}</p></div>}
        {selectedApp.status === 'READY_TO_SUBMIT' && selectedApp.version && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200"><p className="font-semibold">Explicit submission approval required</p><p className="mt-1 text-amber-300/80">This authorizes the worker to submit the exact approved application documents. CAPTCHA, MFA, and authentication challenges still pause for human verification.</p><button type="button" disabled={submissionBusy} onClick={() => void authorizeSelectedSubmission()} className="mt-3 rounded-lg bg-amber-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{submissionBusy ? 'Authorizing…' : 'Authorize submission'}</button></div>}
        {selectedApp.status === 'APPLICATION_STARTED' && <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-200"><p className="font-semibold">Schedule provider form run</p><p className="mt-1 text-indigo-300/80">The run is persisted and will respect automation pause/resume state. Human verification remains required when the provider requests it.</p><div className="mt-3 flex gap-2"><input type="datetime-local" value={scheduleDate} onChange={(event) => setScheduleDate(event.target.value)} aria-label="Application run time" className="min-w-0 flex-1 rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white" /><button type="button" disabled={scheduleBusy || !scheduleDate} onClick={() => void scheduleSelectedRun()} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{scheduleBusy ? 'Scheduling…' : 'Schedule'}</button></div></div>}
        {selectedApp.jobs?.length ? <div className="space-y-2"><h4 className="text-xs font-bold text-slate-400 uppercase font-mono">Durable provider runs</h4>{selectedApp.jobs.map((job) => <div key={job.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs"><div className="flex justify-between gap-2"><span className="font-semibold text-white">{job.type.replace('COMPLETE_', '').replace('_APPLICATION', '')}</span><span className="text-indigo-300">{job.status}</span></div><p className="mt-1 text-slate-500">Due: {date(job.availableAt)} · Attempts: {job.attemptCount}</p>{job.lastError && <p className="mt-1 text-rose-300">{job.lastError}</p>}{['PENDING', 'AVAILABLE'].includes(job.status) && <button type="button" disabled={cancelBusyId === job.id} onClick={() => void cancelSelectedRun(job.id)} className="mt-2 rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 disabled:opacity-50">{cancelBusyId === job.id ? 'Cancelling…' : 'Cancel run'}</button>}</div>)}</div> : null}
        {selectedApp.interviews?.length ? <div className="space-y-2"><h4 className="text-xs font-bold text-slate-400 uppercase font-mono">Interviews</h4>{selectedApp.interviews.map((interview) => <div key={interview.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs"><div className="flex justify-between"><span className="font-bold text-white">Round {interview.round} · {interview.type}</span><span className="text-slate-500">{date(interview.date)}</span></div><p className="text-slate-400 mt-1">{interview.company} · {interview.role}{interview.interviewer ? ` · ${interview.interviewer}` : ''}</p>{safeMeetingUrl(interview.meetingUrl) && <a className="text-indigo-300 hover:text-indigo-200 mt-1 inline-block" href={safeMeetingUrl(interview.meetingUrl)} target="_blank" rel="noreferrer">Open meeting link</a>}</div>)}</div> : null}
        {selectedApp.offers?.length ? <div className="space-y-2"><h4 className="text-xs font-bold text-slate-400 uppercase font-mono">Offers</h4>{selectedApp.offers.map((offer) => <div key={offer.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs"><div className="flex justify-between"><span className="font-bold text-white">{offer.company} · {offer.role}</span><span className="text-emerald-300">{offer.status}</span></div>{offer.salaryOffered !== undefined && <p className="text-slate-400 mt-1">Compensation: {offer.currency ? `${offer.currency} ` : ''}{offer.salaryOffered.toLocaleString()}</p>}{offer.startDate && <p className="text-slate-500 mt-1">Start: {date(offer.startDate)}</p>}{offer.status === 'PENDING' && <div className="flex gap-2 mt-3"><button type="button" disabled={offerBusyId === offer.id} onClick={() => void applyOfferDecision(offer.id, 'ACCEPTED')} className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">Accept</button><button type="button" disabled={offerBusyId === offer.id} onClick={() => void applyOfferDecision(offer.id, 'DECLINED')} className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 disabled:opacity-50">Decline</button></div>}</div>)}</div> : null}
        <details className="rounded-xl border border-slate-800 bg-slate-950 p-3"><summary className="cursor-pointer text-xs font-bold text-slate-300">Record a reviewed lifecycle event</summary><div className="mt-3 space-y-4"><form onSubmit={submitInterview} className="space-y-2"><p className="text-[11px] text-slate-400">Interview</p><div className="grid grid-cols-2 gap-2"><input required maxLength={500} value={interviewType} onChange={(event) => setInterviewType(event.target.value)} placeholder="Interview type" aria-label="Interview type" className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white" /><input type="datetime-local" value={interviewDate} onChange={(event) => setInterviewDate(event.target.value)} aria-label="Interview date" className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white" /></div><button type="submit" disabled={lifecycleBusy !== null} className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{lifecycleBusy === 'INTERVIEW' ? 'Recording…' : 'Record interview'}</button></form><form onSubmit={submitOffer} className="space-y-2"><p className="text-[11px] text-slate-400">Offer</p><div className="grid grid-cols-2 gap-2"><input inputMode="decimal" value={offerSalary} onChange={(event) => setOfferSalary(event.target.value)} placeholder="Compensation" aria-label="Offer compensation" className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white" /><input maxLength={20} value={offerCurrency} onChange={(event) => setOfferCurrency(event.target.value)} placeholder="Currency" aria-label="Offer currency" className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5 text-xs text-white" /></div><button type="submit" disabled={lifecycleBusy !== null} className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{lifecycleBusy === 'OFFER' ? 'Recording…' : 'Record offer'}</button></form></div></details>
        {selectedApp.emailOutcomes?.length ? <div className="space-y-2"><h4 className="text-xs font-bold text-slate-400 uppercase font-mono">Email outcomes</h4>{selectedApp.emailOutcomes.map((outcome) => { const actionable = ['REJECTION', 'INTERVIEW_INVITATION', 'OFFER', 'WITHDRAWAL'].includes(outcome.classification); return <div key={outcome.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs"><div className="flex justify-between"><span className="font-bold text-white">{outcome.classification.split('_').join(' ')}</span><span className="text-slate-400">{outcome.confidence}</span></div><p className="text-slate-500 mt-1">Received: {date(outcome.receivedAt)}</p><p className={`mt-1 ${outcome.reviewedAt ? 'text-emerald-300' : 'text-amber-300'}`}>{outcome.reviewedAt ? `Reviewed ${date(outcome.reviewedAt)}${outcome.reviewedBy ? ` by ${outcome.reviewedBy}` : ''}` : 'Needs human review'}</p>{actionable && selectedApp.version && (outcome.reviewedAt ? <button type="button" disabled={emailBusyId === outcome.id} onClick={() => void applyReviewedEmailOutcome(outcome.id)} className="mt-2 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{emailBusyId === outcome.id ? 'Applying…' : 'Apply reviewed outcome'}</button> : <button type="button" disabled={emailBusyId === outcome.id} onClick={() => void reviewSelectedEmailOutcome(outcome.id)} className="mt-2 rounded-lg bg-amber-600 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">{emailBusyId === outcome.id ? 'Reviewing…' : 'Mark reviewed'}</button>)}</div>; })}</div> : null}
        <div className="space-y-3"><h4 className="text-xs font-bold text-slate-400 uppercase font-mono">Recorded attempts</h4>{detailLoading ? <p className="text-xs text-slate-500">Loading attempt details…</p> : selectedApp.attempts?.length ? selectedApp.attempts.map((attempt) => <div key={attempt.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs"><div className="flex justify-between"><span className="font-bold text-white">Attempt #{attempt.attemptNumber}</span><span className="text-slate-500">{date(attempt.startedAt)}</span></div><p className="text-slate-400 mt-1">Status: {attempt.status} · Fields filled: {attempt.fieldsFilled}/{attempt.fieldsDetected}</p>{attempt.error && <p className="text-rose-300 mt-1">{attempt.error}</p>}</div>) : <p className="text-xs text-slate-500">No browser attempts have been recorded for this application yet.</p>}</div>
      </div>}</div>
    </div>}
  </div>;
};

const StatusBadge = ({ status }: { status: string }) => <span className="px-2.5 py-1 rounded-full bg-indigo-500/15 text-indigo-300 text-xs font-mono font-semibold border border-indigo-500/30">{status.split('_').join(' ')}</span>;
const State = ({ text, error = false }: { text: string; error?: boolean }) => <div role={error ? 'alert' : 'status'} className={`p-8 rounded-2xl border bg-slate-900/60 text-center text-sm ${error ? 'border-rose-500/30 text-rose-300' : 'border-slate-800 text-slate-400'}`}>{text}</div>;
