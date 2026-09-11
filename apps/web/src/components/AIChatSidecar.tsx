import React, { useState } from 'react';
import { Bot, Send, X, Sparkles, User, RefreshCw } from 'lucide-react';
import { chatWithAssistant, hasApiToken } from '../services/api';

interface AIChatSidecarProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AIChatSidecar: React.FC<AIChatSidecarProps> = ({ isOpen, onClose }) => {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string; time: string }>>([
    {
      role: 'assistant',
      text: 'Hello! I can help with job-search strategy, resume wording, and interview preparation. I only use details you provide and will not claim actions were completed.',
      time: 'Just now',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    const nextMessages = [...messages, { role: 'user' as const, text: userMsg, time: 'Just now' }];
    setInput('');
    setMessages(nextMessages);

    if (!hasApiToken()) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: 'Sign in first to use the configured AI assistant.',
        time: 'Just now',
      }]);
      return;
    }

    setLoading(true);
    try {
      const reply = await chatWithAssistant(nextMessages.map(({ role, text }) => ({ role, content: text })));
      setMessages((prev) => [...prev, { role: 'assistant', text: reply, time: 'Just now' }]);
    } catch (error) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: error instanceof Error ? error.message : 'The AI assistant is unavailable.',
        time: 'Just now',
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside
      className="fixed inset-x-3 bottom-3 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96 h-[min(560px,calc(100vh-1.5rem))] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl z-50 flex flex-col overflow-hidden animate-in slide-in-from-bottom-5"
      role="dialog"
      aria-modal="true"
      aria-label="JobAgent assistant"
    >
      {/* Header */}
      <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
              JobAgent AI Sidecar
            </h3>
            <p className="text-[10px] text-emerald-400 font-mono flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              API-backed assistant
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close assistant" className="p-1 text-slate-400 hover:text-white rounded-lg">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 p-4 overflow-y-auto space-y-3 bg-slate-950/40" aria-live="polite">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex gap-2.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {m.role === 'assistant' && (
              <div className="w-7 h-7 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-3.5 h-3.5 text-indigo-400" />
              </div>
            )}
            <div
              className={`max-w-[80%] p-3 rounded-2xl text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-tr-none'
                  : 'bg-slate-900 border border-slate-800 text-slate-200 rounded-tl-none'
              }`}
            >
              {m.text}
              <div className="mt-1 text-[9px] opacity-60 text-right font-mono">{m.time}</div>
            </div>
            {m.role === 'user' && (
              <div className="w-7 h-7 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="w-3.5 h-3.5 text-slate-300" />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex gap-2 items-center text-slate-400 text-xs font-mono">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
            Waiting for the AI assistant...
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-3 bg-slate-900 border-t border-slate-800 flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          aria-label="Message assistant"
          placeholder="Ask about resumes or interviews..."
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || loading}
          aria-label="Send message"
          className="p-2 bg-indigo-600 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 text-white rounded-xl transition-colors"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </aside>
  );
};
