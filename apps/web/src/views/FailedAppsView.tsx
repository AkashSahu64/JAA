import React from 'react';
import { AlertTriangle } from 'lucide-react';

export const FailedAppsView: React.FC = () => (
  <div className="space-y-6">
    <div><h1 className="text-2xl font-bold text-white">Human Review Room</h1><p className="text-xs text-slate-400">Review applications that need manual attention.</p></div>
    <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 text-center space-y-3">
      <AlertTriangle className="w-9 h-9 text-amber-400 mx-auto" />
      <h2 className="font-bold text-white">Interactive review is not available</h2>
      <p className="text-sm text-slate-400 max-w-xl mx-auto">The current API does not provide CAPTCHA, MFA-code, custom-question, or retry endpoints. Applications marked WAITING_FOR_USER can be inspected in the Application Queue, but this interface will not claim to resume or submit them.</p>
    </div>
  </div>
);
