import React from 'react';
import { 
  LayoutDashboard, 
  Briefcase, 
  FileText, 
  Send, 
  Cpu, 
  AlertTriangle, 
  BarChart3, 
  Settings, 
  Bot, 
  Sparkles,
  Zap,
  Activity
} from 'lucide-react';
import { NavView } from '../types';

interface SidebarProps {
  currentView: NavView;
  onSelectView: (view: NavView) => void;
  automationRunning: boolean;
  automationBusy: boolean;
  onToggleAutomation: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  automationRunning,
  automationBusy,
  onToggleAutomation,
}) => {
  const navItems: Array<{ id: NavView; label: string; icon: React.ReactNode; badge?: string; alert?: boolean }> = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-5 h-5" /> },
    { id: 'jobs', label: 'Job Discovery', icon: <Briefcase className="w-5 h-5" /> },
    { id: 'resumes', label: 'Resume Studio', icon: <FileText className="w-5 h-5" /> },
    { id: 'applications', label: 'Application Queue', icon: <Send className="w-5 h-5" /> },
    { id: 'automation', label: 'Automation Control', icon: <Cpu className="w-5 h-5" /> },
    { id: 'failed-apps', label: 'Review Room', icon: <AlertTriangle className="w-5 h-5" /> },
    { id: 'analytics', label: 'Analytics & Insights', icon: <BarChart3 className="w-5 h-5" /> },
    { id: 'settings', label: 'Rules & Settings', icon: <Settings className="w-5 h-5" /> },
  ];

  return (
    <aside className="w-64 shrink-0 bg-slate-900/80 backdrop-blur-xl border-r border-slate-800/80 flex flex-col justify-between h-screen sticky top-0 z-40 select-none">
      <div>
        {/* Brand Header */}
        <div className="p-5 flex items-center justify-between border-b border-slate-800/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-cyan-400 p-0.5 shadow-lg shadow-indigo-500/20">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                <Bot className="w-6 h-6 text-indigo-400 animate-pulse-slow" />
              </div>
            </div>
            <div>
              <h1 className="font-bold text-lg leading-none tracking-tight text-white flex items-center gap-1.5">
                JobAgent <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">AI 2.0</span>
              </h1>
              <p className="text-xs text-slate-400 mt-0.5 font-mono">Assisted workflows</p>
            </div>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="p-3 space-y-1 mt-2">
          {navItems.map((item) => {
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectView(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl font-medium text-sm transition-all duration-200 ${
                  isActive
                    ? 'bg-gradient-to-r from-indigo-600/30 to-purple-600/20 text-indigo-300 border border-indigo-500/30 shadow-lg shadow-indigo-500/10'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`${isActive ? 'text-indigo-400' : 'text-slate-400'}`}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-mono font-semibold ${
                      item.alert
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse'
                        : isActive
                        ? 'bg-indigo-500/20 text-indigo-300'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer System Widget */}
      <div className="p-4 border-t border-slate-800/60 bg-slate-950/40">
        <div className="p-3.5 rounded-2xl bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800/80 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                {automationRunning && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                )}
                <span
                  className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                    automationRunning ? 'bg-emerald-500' : 'bg-slate-500'
                  }`}
                ></span>
              </span>
              <span className="text-xs font-semibold text-slate-300 font-mono">
                {automationRunning ? 'RUN RECORD ACTIVE' : 'SYSTEM IDLE'}
              </span>
            </div>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
              ASSISTED
            </span>
          </div>

          <button
            onClick={onToggleAutomation}
            disabled={automationBusy}
            aria-pressed={automationRunning}
            className={`w-full py-2 px-3 rounded-xl font-semibold text-xs flex items-center justify-center gap-2 transition-all duration-200 shadow-md disabled:cursor-wait disabled:opacity-60 ${
              automationRunning
                ? 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 shadow-rose-950/20'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-950/30'
            }`}
          >
            {automationRunning ? (
              <>
                <Zap className="w-3.5 h-3.5 text-rose-400" />
                Pause Automation
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 text-emerald-200" />
                Start Assisted Run
              </>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
};
