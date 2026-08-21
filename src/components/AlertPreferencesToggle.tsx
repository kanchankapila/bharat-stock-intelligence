import React, { useState } from 'react';
import { Bell, BellOff, Volume2, VolumeX } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  getAlertPreferences, setAlertPreferences, requestNotificationPermission,
  notificationPermission, notificationSupported, playAlertSound,
} from '../lib/browserNotify';

// Small always-visible control, mounted alongside AlertsToast, so a user can opt in to
// "don't miss a live alert in a background tab" without hunting through a settings page --
// both browser notifications and sound are OFF by default (per the safety/privacy convention
// of not surprising a user with sound/native popups they never asked for).
export function AlertPreferencesToggle() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(getAlertPreferences());
  const [permission, setPermission] = useState(notificationPermission());

  const handleEnableNotifications = async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') setPrefs(getAlertPreferences());
  };

  const toggleNotifications = () => {
    if (permission !== 'granted') { handleEnableNotifications(); return; }
    setPrefs(setAlertPreferences({ notifications: !prefs.notifications }));
  };

  const toggleSound = () => {
    const next = setAlertPreferences({ sound: !prefs.sound });
    setPrefs(next);
    if (next.sound) playAlertSound(); // audible confirmation it's now on
  };

  const anyOn = prefs.notifications || prefs.sound;

  return (
    <div className="relative pointer-events-auto">
      <button
        onClick={() => setOpen(o => !o)}
        title="Alert preferences"
        className={cn(
          'p-2 rounded-xl border shadow-lg backdrop-blur-md transition-colors',
          anyOn ? 'bg-indigo-900/80 border-indigo-500/50 text-indigo-300' : 'bg-slate-900/80 border-slate-700/50 text-slate-400',
        )}
      >
        {anyOn ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-700/60 rounded-xl shadow-2xl p-3 space-y-2 text-xs">
          <p className="text-slate-400 font-semibold font-display uppercase tracking-wider text-[10px] mb-1">Alert Preferences</p>

          <button
            onClick={toggleNotifications}
            className="w-full flex items-center justify-between px-2 py-2 rounded-lg hover:bg-slate-800/60 transition-colors"
          >
            <span className="flex items-center gap-2 text-slate-200">
              {prefs.notifications && permission === 'granted' ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
              Browser notifications
            </span>
            <span className={cn(
              'text-[9px] font-bold uppercase px-2 py-0.5 rounded',
              !notificationSupported() ? 'bg-slate-800 text-slate-500' :
              permission === 'denied' ? 'bg-rose-500/10 text-rose-400' :
              prefs.notifications && permission === 'granted' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400',
            )}>
              {!notificationSupported() ? 'Unsupported' :
               permission === 'denied' ? 'Blocked' :
               prefs.notifications && permission === 'granted' ? 'On' : 'Off'}
            </span>
          </button>
          {permission === 'denied' && (
            <p className="text-[9px] text-slate-500 px-2 leading-snug">
              Blocked in your browser settings — re-enable it for this site to turn notifications back on.
            </p>
          )}

          <button
            onClick={toggleSound}
            className="w-full flex items-center justify-between px-2 py-2 rounded-lg hover:bg-slate-800/60 transition-colors"
          >
            <span className="flex items-center gap-2 text-slate-200">
              {prefs.sound ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              Alert sound
            </span>
            <span className={cn('text-[9px] font-bold uppercase px-2 py-0.5 rounded', prefs.sound ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400')}>
              {prefs.sound ? 'On' : 'Off'}
            </span>
          </button>

          <p className="text-[9px] text-slate-500 px-2 pt-1 leading-snug">
            Notifications only fire while this tab is in the background — an in-app toast already covers the foreground case.
          </p>
        </div>
      )}
    </div>
  );
}

export default AlertPreferencesToggle;
