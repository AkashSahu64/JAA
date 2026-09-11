import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import { fetchResumes, uploadResume, fetchResumeFacts, decideResumeFact } from '../services/api';
import { UICandidateFact, UIResume, UIResumeVersion } from '../types';

export const ResumesView: React.FC = () => {
  const [resumes, setResumes] = useState<UIResume[]>([]);
  const [selected, setSelected] = useState<UIResumeVersion | null>(null);
  const [selectedResume, setSelectedResume] = useState<UIResume | null>(null);
  const [facts, setFacts] = useState<UICandidateFact[]>([]);
  const [decidingFactId, setDecidingFactId] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const versions = useMemo(() => resumes.flatMap((resume) => resume.versions), [resumes]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchResumes();
      setResumes(data);
      setSelected((current) => data.flatMap((resume) => resume.versions).find((version) => version.id === current?.id) ?? data.flatMap((resume) => resume.versions)[0] ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load resumes.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const inspectResume = async (resume: UIResume) => {
    setSelectedResume(resume);
    setSelected(null);
    setError('');
    try {
      setFacts(await fetchResumeFacts(resume.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load candidate facts.');
    }
  };

  const decideFact = async (fact: UICandidateFact, decision: 'APPROVE' | 'REJECT') => {
    if (!selectedResume) return;
    setDecidingFactId(fact.id);
    setError('');
    try {
      await decideResumeFact(selectedResume.id, fact.id, decision);
      setFacts(await fetchResumeFacts(selectedResume.id));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record the decision.');
    } finally {
      setDecidingFactId('');
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    setMessage('');
    try {
      await uploadResume(file);
      setMessage(`${file.name} uploaded and parsed.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  return <div className="space-y-6">
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"><div><h1 className="text-2xl font-bold text-white">Resume Studio</h1><p className="text-xs text-slate-400">Master resumes and generated versions stored by your authenticated account.</p></div><input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={handleUpload} className="sr-only" /><button type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()} className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 disabled:opacity-60 text-white font-semibold text-xs flex gap-2"><Upload className="w-4 h-4" />{uploading ? 'Uploading…' : 'Upload master resume'}</button></div>
    {message && <div role="status" className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">{message}</div>}
    {error && <div role="alert" className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">{error}</div>}
    {loading ? <State text="Loading resumes…" /> : resumes.length === 0 ? <State text="No resumes uploaded yet. Upload a PDF, DOCX, or TXT file (up to 10 MB) to create a master resume." /> : <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-4 space-y-5"><section><h2 className="text-xs font-bold text-slate-400 uppercase font-mono px-1 mb-3">Master resumes</h2><div className="space-y-2">{resumes.map((resume) => <button key={resume.id} type="button" onClick={() => void inspectResume(resume)} className="w-full p-4 rounded-2xl bg-slate-900 border border-slate-800 text-left"><div className="flex gap-2"><FileText className="w-4 h-4 text-indigo-400" /><div><h3 className="text-sm font-bold text-white">{resume.name}</h3><p className="text-[11px] text-slate-400">{resume.fileName || 'Stored text'} · {new Date(resume.createdAt).toLocaleDateString()}</p><p className={`text-[10px] mt-1 ${resume.pendingFactCount ? 'text-amber-300' : 'text-emerald-300'}`}>{resume.pendingFactCount ? `${resume.pendingFactCount} facts need review` : 'No pending facts'}</p></div></div></button>)}</div></section>
      <section><h2 className="text-xs font-bold text-slate-400 uppercase font-mono px-1 mb-3">Generated versions</h2>{versions.length ? <div className="space-y-2">{versions.map((version) => <button type="button" key={version.id} onClick={() => { setSelected(version); setSelectedResume(null); }} aria-pressed={selected?.id === version.id} className={`w-full p-4 rounded-2xl border text-left ${selected?.id === version.id ? 'bg-slate-900 border-indigo-500/60' : 'bg-slate-900/60 border-slate-800'}`}><h3 className="font-bold text-sm text-white">{version.name}</h3><p className="text-[10px] text-slate-500">{new Date(version.generatedAt).toLocaleString()}</p></button>)}</div> : <p className="text-xs text-slate-500 px-1">No tailored versions have been generated.</p>}</section></div>
      <div className="lg:col-span-8">{selectedResume ? <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4"><div><p className="text-xs font-mono text-indigo-400">Candidate fact review</p><h2 className="font-bold text-lg text-white">{selectedResume.name}</h2><p className="text-xs text-slate-400">Parser output is unapproved by default. Approve only claims supported by the exact cited text.</p></div>{facts.length ? facts.map((fact) => <div key={fact.id} className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2"><div className="flex items-center justify-between gap-3"><span className="text-[10px] font-mono text-indigo-300">{fact.factType}</span><span className={`text-[10px] ${fact.approved ? 'text-emerald-300' : 'text-amber-300'}`}>{fact.approved ? 'Approved' : 'Needs review'}</span></div><blockquote className="text-sm text-white border-l-2 border-indigo-500 pl-3">{fact.sourceText}</blockquote><p className="text-[10px] text-slate-500">Exact source range: {fact.sourceStart ?? 'unknown'}–{fact.sourceEnd ?? 'unknown'}</p>{!fact.approved && <div className="flex gap-2"><button disabled={decidingFactId === fact.id} onClick={() => void decideFact(fact, 'APPROVE')} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-xs text-white disabled:opacity-50">Approve</button><button disabled={decidingFactId === fact.id} onClick={() => void decideFact(fact, 'REJECT')} className="px-3 py-1.5 rounded-lg border border-rose-500/50 text-xs text-rose-300 disabled:opacity-50">Reject</button></div>}</div>) : <p className="text-xs text-slate-500">No parsed facts remain for this resume.</p>}</div> : selected ? <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-5"><div className="border-b border-slate-800 pb-4"><p className="text-xs font-mono text-indigo-400">{selected.company || 'No company'} · {selected.role || 'No target role'}</p><h2 className="font-bold text-lg text-white">{selected.name}</h2></div><div className="grid grid-cols-2 gap-3"><Metric label="ATS score" value={selected.atsScore === undefined ? 'Not scored' : `${Math.round(selected.atsScore)}%`} /><Metric label="Keyword coverage" value={`${Math.round(selected.keywordCoverage)}%`} /></div><section><h3 className="text-xs font-bold text-slate-300 mb-2">Recorded changes</h3>{selected.changes.length ? selected.changes.map((change) => <p key={change} className="p-2.5 mb-2 rounded-xl bg-slate-950 text-xs text-slate-300">{change}</p>) : <p className="text-xs text-slate-500">No structured change records.</p>}</section><section><h3 className="text-xs font-bold text-slate-300 mb-2">Source facts</h3>{selected.provenance.length ? selected.provenance.map((fact, index) => <div key={`${fact.claim}-${index}`} className="p-3 mb-2 rounded-xl bg-slate-950 border border-slate-800 text-xs"><p className="text-white">{fact.claim}</p><p className="text-slate-500">Source: {fact.source} · {fact.verified ? 'verified' : 'not verified'}</p></div>) : <p className="text-xs text-slate-500">No provenance records are available for this version.</p>}</section></div> : <State text="Select a generated version to inspect it. Resume tailoring is not exposed by the current API." />}</div>
    </div>}
  </div>;
};

const Metric = ({ label, value }: { label: string; value: string }) => <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-center"><span className="text-[10px] font-mono text-slate-400 uppercase">{label}</span><div className="text-xl font-extrabold text-indigo-300">{value}</div></div>;
const State = ({ text }: { text: string }) => <div role="status" className="p-8 rounded-2xl border border-slate-800 bg-slate-900/60 text-center text-sm text-slate-400">{text}</div>;
