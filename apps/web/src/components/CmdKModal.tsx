import React, { useState, useEffect, useId } from 'react';
import { Search, Briefcase, FileText, Send, Zap, Settings, X, ChevronRight } from 'lucide-react';
import { NavView } from '../types';

interface CmdKModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectView: (view: NavView) => void;
  onStartAutomation: () => void;
}

export const CmdKModal: React.FC<CmdKModalProps> = ({
  isOpen,
  onClose,
  onSelectView,
  onStartAutomation,
}) => {
  const [query, setQuery] = useState('');
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const actions = [
    { label: 'Go to Dashboard', view: 'dashboard' as NavView, icon: <Zap className="w-4 h-4 text-indigo-400" /> },
    { label: 'Browse Discovered Jobs', view: 'jobs' as NavView, icon: <Briefcase className="w-4 h-4 text-cyan-400" /> },
    { label: 'Open Resume Studio', view: 'resumes' as NavView, icon: <FileText className="w-4 h-4 text-emerald-400" /> },
    { label: 'View Application Records', view: 'applications' as NavView, icon: <Send className="w-4 h-4 text-purple-400" /> },
    { label: 'Configure Automation Rules', view: 'settings' as NavView, icon: <Settings className="w-4 h-4 text-amber-400" /> },
  ];

  const filtered = actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-start justify-center pt-24 px-4 animate-in fade-in"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="sr-only">Command menu</h2>
        {/* Input */}
        <div className="p-4 border-b border-slate-800 flex items-center gap-3">
          <Search className="w-5 h-5 text-indigo-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search commands"
            placeholder="Type a command or search..."
            className="w-full bg-transparent text-white placeholder-slate-500 focus:outline-none text-base"
            autoFocus
          />
          <button type="button" onClick={onClose} aria-label="Close command menu" className="p-1 text-slate-400 hover:text-white rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Results */}
        <div className="p-2 space-y-1 max-h-80 overflow-y-auto">
          <div className="px-3 py-1 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
            Quick Actions
          </div>
          <button
            onClick={() => {
              onStartAutomation();
              onClose();
            }}
            className="w-full px-3 py-2.5 rounded-xl hover:bg-indigo-600/20 text-left flex items-center justify-between text-indigo-300 text-sm font-medium transition-colors"
          >
            <div className="flex items-center gap-3">
              <Zap className="w-4 h-4 text-indigo-400" />
              <span>Start Assisted Run</span>
            </div>
            <span className="text-xs bg-indigo-500/20 px-2 py-0.5 rounded font-mono">Run</span>
          </button>

          <div className="px-3 py-1 mt-2 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
            Navigation
          </div>
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">No matching commands.</p>
          )}
          {filtered.map((item) => (
            <button
              key={item.view}
              onClick={() => {
                onSelectView(item.view);
                onClose();
              }}
              className="w-full px-3 py-2.5 rounded-xl hover:bg-slate-800 text-left flex items-center justify-between text-slate-200 text-sm font-medium transition-colors"
            >
              <div className="flex items-center gap-3">
                {item.icon}
                <span>{item.label}</span>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-600" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
