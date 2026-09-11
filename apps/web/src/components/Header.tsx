import React, { useEffect, useState } from 'react';
import { Search, Bell, Sparkles, Command, ShieldCheck, CheckCircle2, User, LogOut } from 'lucide-react';
import { AuthUser } from '../types';
import { fetchNotifications, markAllNotificationsRead, UINotification } from '../services/api';

interface HeaderProps {
  user: AuthUser;
  onSignOut: () => void;
  onOpenCmdK: () => void;
  onOpenAIChat: () => void;
}

export const Header: React.FC<HeaderProps> = ({ user, onSignOut, onOpenCmdK, onOpenAIChat }) => {
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<UINotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationError, setNotificationError] = useState('');

  useEffect(() => {
    if (!showNotifications) return;
    setNotificationsLoading(true);
    setNotificationError('');
    void fetchNotifications()
      .then(setNotifications)
      .catch((error) => setNotificationError(error instanceof Error ? error.message : 'Could not load notifications.'))
      .finally(() => setNotificationsLoading(false));
  }, [showNotifications]);

  const markAllRead = async () => {
    setNotificationError('');
    try {
      await markAllNotificationsRead();
      setNotifications((current) => current.map((notification) => ({ ...notification, read: true })));
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : 'Could not mark notifications as read.');
    }
  };

  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const notificationIcon = (type: string) => {
    const normalized = type.toLowerCase();
    if (normalized.includes('fail') || normalized.includes('required') || normalized.includes('warning')) {
      return <span className="w-2 h-2 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />;
    }
    if (normalized.includes('confirm') || normalized.includes('submit') || normalized.includes('success')) {
      return <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />;
    }
    return <ShieldCheck className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />;
  };

  return (
    <header className="h-16 border-b border-slate-800/80 bg-slate-900/40 backdrop-blur-xl px-6 flex items-center justify-between sticky top-0 z-30">
      {/* Search Input with Cmd+K hint */}
      <div className="flex items-center gap-3 w-96">
        <button
          onClick={onOpenCmdK}
          className="w-full flex items-center justify-between px-3.5 py-2 bg-slate-950/60 hover:bg-slate-950/90 border border-slate-800 rounded-xl text-slate-400 text-sm transition-all group"
        >
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-slate-500 group-hover:text-indigo-400 transition-colors" />
            <span>Search jobs, applications, skills...</span>
          </div>
          <kbd className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/60">
            <Command className="w-3 h-3" /> K
          </kbd>
        </button>
      </div>

      {/* Action Icons & Profile */}
      <div className="flex items-center gap-3">
        {/* AI Assistant Quick Trigger */}
        <button
          onClick={onOpenAIChat}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gradient-to-r from-indigo-500/20 to-purple-500/20 hover:from-indigo-500/30 hover:to-purple-500/30 text-indigo-300 border border-indigo-500/30 text-xs font-semibold shadow-sm transition-all"
        >
          <Sparkles className="w-4 h-4 text-indigo-400 animate-pulse" />
          <span>Ask JobAgent AI</span>
        </button>

        {/* Notifications Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowNotifications(!showNotifications)}
            aria-label="Notifications"
            aria-expanded={showNotifications}
            className="w-9 h-9 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 flex items-center justify-center text-slate-300 relative transition-all"
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 min-w-2 h-2 rounded-full bg-indigo-500 ring-4 ring-slate-900" />
            )}
          </button>

          {showNotifications && (
            <div className="absolute right-0 mt-2 w-80 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-3 z-50 animate-in fade-in slide-in-from-top-2">
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
                <span className="font-semibold text-xs text-white">Notifications</span>
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  disabled={unreadCount === 0}
                  className="text-[10px] text-indigo-400 hover:underline disabled:text-slate-600 disabled:no-underline"
                >
                  Mark all read
                </button>
              </div>
              <div className="space-y-2" aria-live="polite">
                {notificationsLoading && (
                  <p className="px-2 py-4 text-center text-xs text-slate-500">Loading notifications…</p>
                )}
                {notificationError && (
                  <p className="px-2 py-3 text-xs text-rose-300 bg-rose-500/10 rounded-lg">{notificationError}</p>
                )}
                {!notificationsLoading && !notificationError && notifications.length === 0 && (
                  <p className="px-2 py-4 text-center text-xs text-slate-500">No notifications.</p>
                )}
                {notifications.map((notification) => (
                  <div key={notification.id} className={`p-2.5 rounded-xl border flex items-start gap-2.5 ${notification.read ? 'bg-slate-950/30 border-slate-800/40 opacity-70' : 'bg-slate-950/60 border-slate-800/60'}`}>
                    {notificationIcon(notification.type)}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-white truncate">{notification.title}</p>
                      <p className="text-[11px] text-slate-400 line-clamp-2">{notification.message}</p>
                      <time className="text-[9px] text-slate-500 font-mono" dateTime={notification.createdAt}>
                        {new Date(notification.createdAt).toLocaleString()}
                      </time>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* User Profile Info */}
        <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-purple-500 to-indigo-500 p-0.5">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
              <User className="w-4 h-4 text-indigo-300" />
            </div>
          </div>
          <div className="hidden md:block">
            <p className="text-xs font-semibold text-white leading-tight">{user.name}</p>
            <p className="text-[10px] text-slate-400 font-mono max-w-36 truncate">{user.email}</p>
          </div>
          <button type="button" onClick={onSignOut} aria-label="Sign out" title="Sign out" className="w-9 h-9 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
