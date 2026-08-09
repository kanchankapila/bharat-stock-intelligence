// Shared "don't miss a live alert in a background tab" utility, used by both alert pipelines
// this app has: useAlerts.ts (SSE, price-alert triggers) and AppShell.tsx's WS toast (new
// signals / price crosses). Both previously only rendered an in-app toast, which is invisible
// if the tab isn't focused -- the whole point of a price/signal alert is to catch the user's
// attention when they're NOT looking at the app.

const PREF_KEY = 'bharat.alertPreferences.v1';

export interface AlertPreferences {
  notifications: boolean; // fire a browser Notification when the tab is backgrounded
  sound: boolean;          // play a short tone alongside every alert (foreground or background)
}

const DEFAULT_PREFS: AlertPreferences = { notifications: false, sound: false };

export function getAlertPreferences(): AlertPreferences {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function setAlertPreferences(prefs: Partial<AlertPreferences>): AlertPreferences {
  const next = { ...getAlertPreferences(), ...prefs };
  try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

export function notificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!notificationSupported()) return 'unsupported';
  return Notification.permission;
}

/** Must be called from a user gesture (click handler) -- browsers reject a bare auto-call. */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationSupported()) return 'unsupported';
  const result = await Notification.requestPermission();
  if (result === 'granted') setAlertPreferences({ notifications: true });
  return result;
}

/**
 * Fires a native browser notification, but ONLY when the tab is actually backgrounded --
 * an in-app toast already covers the foreground case, and doubling up would be noisy.
 * No-ops silently if unsupported, not permitted, or the user has notifications off.
 */
export function showBrowserNotification(title: string, body?: string): void {
  if (!notificationSupported() || Notification.permission !== 'granted') return;
  if (!getAlertPreferences().notifications) return;
  if (document.visibilityState === 'visible') return;
  try {
    new Notification(title, { body, tag: 'bharat-alert' });
  } catch {
    // Some browsers (mobile Safari, some Android WebViews) throw on `new Notification`
    // even when Notification.permission reads 'granted' -- fail silently, the in-app
    // toast has already shown the same information.
  }
}

let audioCtx: AudioContext | null = null;
let lastPlayedAt = 0;
const SOUND_DEBOUNCE_MS = 800; // avoid an overlapping-beep wall when several alerts land at once

/** Short, synthesized two-tone chime -- no bundled audio asset needed. Debounced. */
export function playAlertSound(): void {
  if (!getAlertPreferences().sound) return;
  const now = Date.now();
  if (now - lastPlayedAt < SOUND_DEBOUNCE_MS) return;
  lastPlayedAt = now;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch {
    // Audio is a nice-to-have; never let it break the actual alert delivery.
  }
}

/** Convenience wrapper: fire both the (backgrounded-only) notification and the (opt-in) sound. */
export function notifyAlert(title: string, body?: string): void {
  showBrowserNotification(title, body);
  playAlertSound();
}
