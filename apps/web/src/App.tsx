import React, { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { CmdKModal } from './components/CmdKModal';
import { AIChatSidecar } from './components/AIChatSidecar';
import { AuthView } from './components/AuthView';
import { DashboardView } from './views/DashboardView';
import { JobsView } from './views/JobsView';
import { ResumesView } from './views/ResumesView';
import { ApplicationsView } from './views/ApplicationsView';
import { AutomationView } from './views/AutomationView';
import { FailedAppsView } from './views/FailedAppsView';
import { AnalyticsView } from './views/AnalyticsView';
import { SettingsView } from './views/SettingsView';
import { AuthUser, NavView } from './types';
import { AuthSession, clearSession, fetchAutomationStatus, restoreSession, setAutomationState } from './services/api';

export function App() {
  const [currentView, setCurrentView] = useState<NavView>('dashboard');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [automationPaused, setAutomationPaused] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [isCmdKOpen, setIsCmdKOpen] = useState(false);
  const [isAIChatOpen, setIsAIChatOpen] = useState(false);

  useEffect(() => {
    void restoreSession().then((session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    void fetchAutomationStatus().then((run) => {
      setAutomationRunning(run?.status === 'RUNNING');
      setAutomationPaused(run?.status === 'PAUSED');
    }).catch(() => undefined);
  }, [user]);

  const onAuthenticated = (session: AuthSession) => setUser(session.user);
  const signOut = () => {
    clearSession();
    setUser(null);
    setAutomationRunning(false);
    setAutomationPaused(false);
  };

  const toggleAutomation = useCallback(async () => {
    if (automationBusy) return;
    const nextState = !automationRunning;
    setAutomationBusy(true);
    try {
      const run = await setAutomationState(nextState, automationPaused);
      setAutomationRunning(run.status === 'RUNNING');
      setAutomationPaused(run.status === 'PAUSED');
      setStatusMessage(nextState ? 'Automation run record started.' : 'Automation run paused.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Could not update automation.');
    } finally {
      setAutomationBusy(false);
    }
  }, [automationBusy, automationPaused, automationRunning]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsCmdKOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  if (authLoading) return <div className="min-h-screen bg-slate-950 text-slate-400 grid place-items-center" role="status">Restoring session…</div>;
  if (!user) return <AuthView onAuthenticated={onAuthenticated} />;

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <DashboardView onSelectView={setCurrentView} automationRunning={automationRunning} automationBusy={automationBusy} onToggleAutomation={toggleAutomation} />;
      case 'jobs': return <JobsView />;
      case 'resumes': return <ResumesView />;
      case 'applications': return <ApplicationsView />;
      case 'automation': return <AutomationView automationRunning={automationRunning} automationBusy={automationBusy} onToggleAutomation={toggleAutomation} />;
      case 'failed-apps': return <FailedAppsView />;
      case 'analytics': return <AnalyticsView />;
      case 'settings': return <SettingsView />;
      default: return null;
    }
  };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100 font-sans">
      <Sidebar currentView={currentView} onSelectView={setCurrentView} automationRunning={automationRunning} automationBusy={automationBusy} onToggleAutomation={toggleAutomation} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header user={user} onSignOut={signOut} onOpenCmdK={() => setIsCmdKOpen(true)} onOpenAIChat={() => setIsAIChatOpen(true)} />
        <main className="flex-1 p-6 md:p-8 overflow-y-auto">{renderView()}</main>
      </div>
      <CmdKModal isOpen={isCmdKOpen} onClose={() => setIsCmdKOpen(false)} onSelectView={setCurrentView} onStartAutomation={() => { if (!automationRunning) void toggleAutomation(); }} />
      <AIChatSidecar isOpen={isAIChatOpen} onClose={() => setIsAIChatOpen(false)} />
      <div className="sr-only" role="status" aria-live="polite">{statusMessage}</div>
    </div>
  );
}

export default App;
