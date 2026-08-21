import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Calendar, Zap, Hourglass, AlertCircle, CheckCircle2, Play, Search,
  RefreshCw, SlidersHorizontal, Terminal, ChevronDown, ChevronUp,
  Loader2, Server, Clock, Settings2, ShieldAlert, Cpu
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

// Category Definitions
const CATEGORIES = [
  { id: 'all', label: 'All Queues', color: 'indigo' },
  { id: 'data-sync', label: 'Data Sync', color: 'emerald' },
  { id: 'signals-analysis', label: 'Signals & Scans', color: 'amber' },
  { id: 'machine-learning', label: 'ML & AI Models', color: 'violet' },
  { id: 'agents', label: 'Autonomous Agents', color: 'sky' },
  { id: 'system-research', label: 'System & Research', color: 'rose' },
] as const;

type CategoryId = typeof CATEGORIES[number]['id'];

function relFromIso(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Unknown';
  const diff = Date.now() - t;
  if (diff < 0) return 'Upcoming';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

function fmtIstTime(value: string | number | null | undefined): string {
  if (value == null) return 'Pending';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Pending';
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function fmtIstDateTime(value: string | number | null | undefined): string {
  if (value == null) return 'Not scheduled';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Not scheduled';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }) + ' IST';
}

// Cron countdown component for real-time ticking
const CronCountdown: React.FC<{ nextTimeIso: string | null }> = ({ nextTimeIso }) => {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    if (!nextTimeIso) {
      setTimeLeft('Not scheduled');
      return;
    }

    const updateTimer = () => {
      const nextTime = Date.parse(nextTimeIso);
      const diff = nextTime - Date.now();

      if (diff <= 0) {
        setTimeLeft('Executing...');
        return;
      }

      const totalSecs = Math.floor(diff / 1000);
      const hrs = Math.floor(totalSecs / 3600);
      const mins = Math.floor((totalSecs % 3600) / 60);
      const secs = totalSecs % 60;

      const formatted = [
        hrs.toString().padStart(2, '0'),
        mins.toString().padStart(2, '0'),
        secs.toString().padStart(2, '0')
      ].join(':');

      setTimeLeft(formatted);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [nextTimeIso]);

  if (!nextTimeIso) return <span className="text-slate-500 text-xs">N/A</span>;

  const isExecuting = timeLeft === 'Executing...';

  return (
    <div className="flex items-center gap-1.5 font-data text-xs">
      <Clock className={cn("w-3.5 h-3.5", isExecuting ? "text-amber-400 animate-pulse" : "text-indigo-400")} />
      <span className={cn(
        "font-black tracking-wider",
        isExecuting ? "text-amber-400 font-extrabold animate-pulse" : "text-indigo-300"
      )}>
        {timeLeft}
      </span>
    </div>
  );
};

export default function JobsDashboardPage() {
  const [activeCategory, setActiveCategory] = useState<CategoryId>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [triggeringQueueId, setTriggeringQueueId] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [successQueueId, setSuccessQueueId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isVisible, setIsVisible] = React.useState(document.visibilityState === 'visible');
  useEffect(() => {
    const handler = () => setIsVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Poll background job status every 3 seconds (paused when tab is hidden)
  const { data: queues = [], isLoading, isRefetching, error } = trpc.getBullMQJobsStatus.useQuery(undefined, {
    refetchInterval: isVisible ? 3000 : false,
    retry: 3,
  });

  const triggerMutation = trpc.triggerBullMQJob.useMutation();

  // Clear success checkmarks and notifications after timeout
  useEffect(() => {
    if (successQueueId) {
      const t = setTimeout(() => setSuccessQueueId(null), 3000);
      return () => clearTimeout(t);
    }
  }, [successQueueId]);

  useEffect(() => {
    if (notification) {
      const t = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(t);
    }
  }, [notification]);

  // Dispatch job trigger
  const handleTriggerJob = async (queueId: string) => {
    setTriggeringQueueId(queueId);
    setNotification(null);

    try {
      const res = await triggerMutation.mutateAsync({ queueId });
      if (res.success) {
        setSuccessQueueId(queueId);
        setNotification({
          message: `Manual job dispatched successfully (ID: ${res.jobId || 'N/A'})`,
          type: 'success'
        });
      } else {
        setNotification({
          message: res.message || 'Failed to dispatch manual job',
          type: 'error'
        });
      }
    } catch (err: any) {
      setNotification({
        message: err.message || 'Failed to connect to backend queue service',
        type: 'error'
      });
    } finally {
      setTriggeringQueueId(null);
    }
  };

  // Check overall connection
  const isRedisOffline = queues.length > 0 && queues.every(q => !q.connected);
  const totalConnected = queues.filter(q => q.connected).length;
  const isPartialOffline = queues.length > 0 && totalConnected < queues.length && totalConnected > 0;

  // Compute metrics summaries
  const totals = queues.reduce(
    (acc, q) => {
      acc.active += q.activeCount || 0;
      acc.waiting += (q.waitingCount || 0) + (q.delayedCount || 0);
      acc.completed += q.completedCount || 0;
      acc.failed += q.failedCount || 0;
      return acc;
    },
    { active: 0, waiting: 0, completed: 0, failed: 0 }
  );

  // Extract all repeating cron schedules
  const allCrons = queues
    .filter(q => q.connected && q.repeatable && q.repeatable.length > 0)
    .flatMap(q =>
      q.repeatable.map(r => ({
        queueId: q.id,
        queueLabel: q.label,
        queueStatus: q.currentStatus,
        queueLastSuccessAt: q.lastSuccessAt,
        jobName: r.name,
        cron: r.cron,
        next: r.next,
        category: q.category
      }))
    );

  // Filter queues based on selection and search query
  const filteredQueues = queues.filter(q => {
    const matchesCategory = activeCategory === 'all' || q.category === activeCategory;
    const matchesSearch =
      q.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      q.desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
      q.id.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  // Extract latest jobs list (up to 10 latest across all visible queues)
  const allRecentJobs = queues
    .filter(q => q.connected && q.recentJobs && q.recentJobs.length > 0)
    .flatMap(q =>
      q.recentJobs.map(j => ({
        ...j,
        queueId: q.id,
        queueLabel: q.label,
        category: q.category
      }))
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10);

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12 animate-in fade-in duration-300">
      
      {/* ─── Floating Top Alerts Panel ─── */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className="fixed top-6 right-6 z-50 w-full max-w-sm pointer-events-auto"
          >
            <div className={cn(
              "p-4 rounded-xl border shadow-2xl backdrop-blur-md flex items-start gap-3",
              notification.type === 'success' 
                ? "bg-emerald-950/80 border-emerald-500/40 text-emerald-200" 
                : "bg-rose-950/80 border-rose-500/40 text-rose-200"
            )}>
              <div className="mt-0.5">
                {notification.type === 'success' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 animate-bounce" />
                ) : (
                  <ShieldAlert className="w-5 h-5 text-rose-400" />
                )}
              </div>
              <div className="flex-1">
                <h4 className="text-xs font-black font-display uppercase tracking-wider font-data">
                  {notification.type === 'success' ? 'Trigger Confirmed' : 'Trigger Failed'}
                </h4>
                <p className="text-[11px] leading-snug mt-1 font-bold text-slate-300">
                  {notification.message}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Page Title Header & Network status banner ─── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/60 pb-6">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 bg-indigo-500/10 rounded-lg text-indigo-400 glow-accent">
              <Cpu className="w-5 h-5" />
            </div>
            <h1 className="v1-title-page">
              Background Jobs & Crons Console
            </h1>
          </div>
          <p className="text-xs text-slate-400 font-bold mt-1 max-w-2xl leading-relaxed">
            Monitor and trigger BullMQ queues responsible for stock quote streams, AI scoring engines, deep learning training models, and automated trading agents.
          </p>
        </div>

        {/* Global connection widget */}
        <div className="flex items-center gap-3 shrink-0 self-start md:self-center">
          <div className={cn(
            "px-3 py-1.5 rounded-full border text-[10px] font-black font-display uppercase tracking-widest font-data flex items-center gap-2 shadow-inner transition-all",
            isRedisOffline
              ? "bg-rose-950/30 border-rose-500/30 text-rose-400"
              : isPartialOffline
              ? "bg-amber-950/30 border-amber-500/30 text-amber-400"
              : "bg-emerald-950/30 border-emerald-500/30 text-emerald-400"
          )}>
            <span className={cn(
              "w-2 h-2 rounded-full",
              isRedisOffline 
                ? "bg-rose-500" 
                : isPartialOffline 
                ? "bg-amber-400 animate-pulse" 
                : "bg-emerald-400 animate-pulse"
            )} />
            <span>
              {isRedisOffline 
                ? "REDIS OFFLINE" 
                : isPartialOffline 
                ? "REDIS WARNING" 
                : "REDIS CONNECTED"}
            </span>
          </div>

          <div className="w-8 h-8 rounded-lg bg-slate-900/60 border border-slate-800/80 flex items-center justify-center text-slate-400 hover:text-slate-200 transition-colors">
            {isRefetching || isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
            ) : (
              <RefreshCw className="w-4 h-4 text-slate-500" />
            )}
          </div>
        </div>
      </div>

      {/* Redis Connection Interruption Screen */}
      {isRedisOffline && (
        <div className="p-8 text-center bg-rose-950/15 border border-rose-500/20 rounded-2xl glow-down flex flex-col items-center justify-center space-y-4">
          <div className="p-4 bg-rose-500/10 rounded-full text-rose-400 animate-pulse">
            <ShieldAlert className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-sm font-black text-rose-300 font-display uppercase tracking-widest font-data">Redis Daemon Unreachable</h3>
            <p className="text-xs text-rose-200/70 max-w-md mt-1 font-bold">
              The application could not establish a connection to the Redis container. Please verify the `bharat_redis` Docker container is running and exposed on port 6379.
            </p>
          </div>
        </div>
      )}

      {/* ─── Summary Metric Cards ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Queues Card */}
        <div className="glass p-4.5 rounded-2xl relative overflow-hidden group hover:border-slate-700/80 transition-all shadow-md">
          <div className="flex justify-between items-start">
            <span className="v1-data-label">Configured Queues</span>
            <div className="p-1.5 bg-slate-800/40 rounded-lg text-slate-300 group-hover:text-indigo-400 transition-colors">
              <Server className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="v1-data-value text-slate-200">{queues.length}</span>
            <span className="text-[10px] text-slate-500 font-bold">Connected ({totalConnected})</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500/30 group-hover:bg-indigo-500 transition-colors" />
        </div>

        {/* Active Jobs Card */}
        <div className="glass p-4.5 rounded-2xl relative overflow-hidden group hover:border-indigo-800/60 transition-all shadow-md">
          <div className="flex justify-between items-start">
            <span className="v1-data-label">Running Jobs</span>
            <div className="p-1.5 bg-indigo-500/10 rounded-lg text-indigo-400 animate-pulse">
              <Zap className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="v1-data-value text-indigo-300">{totals.active}</span>
            <span className="text-[10px] text-indigo-500 font-bold">In-process thread count</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500/30 group-hover:bg-indigo-500 transition-colors" />
        </div>

        {/* Waiting / Delayed Card */}
        <div className="glass p-4.5 rounded-2xl relative overflow-hidden group hover:border-amber-800/60 transition-all shadow-md">
          <div className="flex justify-between items-start">
            <span className="v1-data-label">Pending Jobs</span>
            <div className="p-1.5 bg-amber-500/10 rounded-lg text-amber-400">
              <Hourglass className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="v1-data-value text-amber-300">{totals.waiting}</span>
            <span className="text-[10px] text-amber-500 font-bold">Scheduled & delayed queue size</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500/30 group-hover:bg-amber-500 transition-colors" />
        </div>

        {/* Failed Jobs Card */}
        <div className="glass p-4.5 rounded-2xl relative overflow-hidden group hover:border-rose-800/60 transition-all shadow-md">
          <div className="flex justify-between items-start">
            <span className="v1-data-label">Failed Jobs</span>
            <div className="p-1.5 bg-rose-500/10 rounded-lg text-rose-400">
              <AlertCircle className="w-4 h-4" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="v1-data-value text-rose-400">{totals.failed}</span>
            <span className="text-[10px] text-rose-500 font-bold">Accumulated error rows</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-rose-500/30 group-hover:bg-rose-500 transition-colors" />
        </div>
      </div>

      {/* ─── Repeatable Crons Section ─── */}
      {!isRedisOffline && allCrons.length > 0 && (
        <div className="glass p-5 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-indigo-400" />
              <h2 className="v1-title-section">
                Active Repeatable Cron Schedules
              </h2>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 font-data text-slate-400 font-black">
              {allCrons.length} JOBS REGISTERED
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {allCrons.map((cron, idx) => {
              const catConfig = CATEGORIES.find(c => c.id === cron.category) || CATEGORIES[0];
              return (
                <div key={cron.queueId + '-' + idx} className="v1-card p-3.5 flex flex-col justify-between space-y-3 relative group hover:border-slate-800 transition-all">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-300 whitespace-normal break-words leading-tight">
                        {cron.queueLabel}
                      </span>
                      <span className={cn(
                        "text-[8px] font-black font-display uppercase tracking-wider px-1.5 py-0.5 rounded font-data",
                        cron.category === 'data-sync' ? "bg-emerald-950/40 text-emerald-400 border border-emerald-500/20" :
                        cron.category === 'signals-analysis' ? "bg-amber-950/40 text-amber-400 border border-amber-500/20" :
                        cron.category === 'machine-learning' ? "bg-violet-950/40 text-violet-400 border border-violet-500/20" :
                        cron.category === 'agents' ? "bg-sky-950/40 text-sky-400 border border-sky-500/20" :
                        "bg-rose-950/40 text-rose-400 border border-rose-500/20"
                      )}>
                        {catConfig.label.split(' ')[0]}
                      </span>
                    </div>
                    <h4 className="text-[11px] font-black text-slate-400 font-data font-display uppercase tracking-wider whitespace-normal break-words leading-tight">
                      {cron.jobName}
                    </h4>
                  </div>

                  <div className="flex items-start justify-between gap-3 border-t border-slate-800/40 pt-2 bg-slate-900/10">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[8px] text-slate-500 font-black uppercase font-data tracking-widest">Schedule</span>
                      <span className="text-[10px] font-bold text-slate-300 font-data whitespace-normal break-all">{cron.cron}</span>
                      <span className="text-[9px] text-slate-500 font-bold whitespace-normal break-words">{fmtIstDateTime(cron.next)}</span>
                    </div>

                    <div className="flex flex-col text-right min-w-0">
                      <span className="text-[8px] text-slate-500 font-black uppercase font-data tracking-widest">Next Execution (IST)</span>
                      <CronCountdown nextTimeIso={cron.next} />
                      <span className={cn(
                        "text-[9px] font-black font-display uppercase tracking-wider",
                        cron.queueStatus === 'running' ? 'text-indigo-400' :
                        cron.queueStatus === 'queued' ? 'text-amber-400' :
                        cron.queueStatus === 'idle' ? 'text-emerald-400' :
                        'text-rose-400'
                      )}>
                        {cron.queueStatus || 'offline'}
                      </span>
                      <span className="text-[9px] text-slate-500 whitespace-normal break-words">
                        Last success: {relFromIso(cron.queueLastSuccessAt)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── Queue Grid Filter & Search ─── */}
      <div className="space-y-4">
        {/* Filter bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar pb-1">
            {CATEGORIES.map((cat) => {
              const active = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-xs font-bold font-data font-display uppercase tracking-wider transition-all whitespace-nowrap border shrink-0",
                    active
                      ? "bg-indigo-600/10 border-indigo-500/50 text-indigo-400 shadow-[0_0_12px_rgba(79,70,229,0.15)] font-black"
                      : "bg-slate-950/20 border-slate-800/80 text-slate-400 hover:text-slate-200 hover:border-slate-700"
                  )}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          <div className="relative w-full lg:max-w-xs shrink-0">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search queues by title/desc..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950/40 border border-slate-800/80 hover:border-slate-700/80 focus:border-indigo-500 focus:outline-none pl-9 pr-4 py-1.5 rounded-full text-xs font-bold text-slate-200 placeholder-slate-500 shadow-inner font-data tracking-wide"
            />
          </div>
        </div>

        {/* Queues Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredQueues.map((item) => {
            const isConnected = item.connected;
            const isBusy = triggeringQueueId === item.id;
            const isSuccess = successQueueId === item.id;
            const catConfig = CATEGORIES.find(c => c.id === item.category) || CATEGORIES[0];

            return (
              <motion.div
                key={item.id}
                layoutId={`q-${item.id}`}
                className={cn(
                  "glass rounded-2xl border p-5 flex flex-col justify-between space-y-4 hover:shadow-xl transition-all relative group",
                  isConnected 
                    ? "hover:border-indigo-500/20" 
                    : "border-slate-850 bg-slate-950/15"
                )}
                whileHover={{ y: -3 }}
                transition={{ duration: 0.15 }}
              >
                {/* Accent categories band */}
                <div className={cn(
                  "absolute top-0 left-0 right-0 h-0.5 rounded-t-2xl",
                  item.category === 'data-sync' ? "bg-emerald-500/60" :
                  item.category === 'signals-analysis' ? "bg-amber-500/60" :
                  item.category === 'machine-learning' ? "bg-violet-500/60" :
                  item.category === 'agents' ? "bg-sky-500/60" :
                  "bg-rose-500/60"
                )} />

                {/* Queue Title & Desc */}
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className={cn(
                        "text-[8px] font-black uppercase px-2 py-0.5 rounded border font-data tracking-wider",
                        item.category === 'data-sync' ? "bg-emerald-950/40 text-emerald-400 border-emerald-500/20" :
                        item.category === 'signals-analysis' ? "bg-amber-950/40 text-amber-400 border-amber-500/20" :
                        item.category === 'machine-learning' ? "bg-violet-950/40 text-violet-400 border-violet-500/20" :
                        item.category === 'agents' ? "bg-sky-950/40 text-sky-400 border-sky-500/20" :
                        "bg-rose-950/40 text-rose-400 border-rose-500/20"
                      )}>
                        {catConfig.label}
                      </span>
                      <h3 className="text-sm font-black text-slate-200 mt-1.5 uppercase font-data tracking-wide whitespace-normal break-words leading-tight">
                        {item.label}
                      </h3>
                    </div>

                    <span className={cn(
                      "text-[8px] font-black px-1.5 py-0.5 rounded font-data font-display uppercase tracking-widest shrink-0 border",
                      isConnected
                        ? "bg-emerald-950/30 border-emerald-500/20 text-emerald-400"
                        : "bg-rose-950/30 border-rose-500/20 text-rose-400 animate-pulse"
                    )}>
                      {isConnected ? "ONLINE" : "OFFLINE"}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-400 font-bold leading-normal min-h-[34px]">
                    {item.desc}
                  </p>
                </div>

                {/* Stats grid */}
                <div className="grid grid-cols-5 gap-1.5 border-t border-b border-slate-800/40 py-2.5 bg-slate-900/10 px-2 rounded-xl">
                  {/* Active */}
                  <div className="text-center">
                    <span className="block text-[8px] text-slate-500 font-black uppercase font-data tracking-wider">Active</span>
                    <span className={cn(
                      "text-xs font-black font-data",
                      item.activeCount ? "text-indigo-400 font-extrabold" : "text-slate-400"
                    )}>
                      {item.activeCount || 0}
                    </span>
                  </div>

                  {/* Waiting */}
                  <div className="text-center">
                    <span className="block text-[8px] text-slate-500 font-black uppercase font-data tracking-wider">Wait</span>
                    <span className="text-xs font-black font-data text-slate-400">
                      {item.waitingCount || 0}
                    </span>
                  </div>

                  {/* Delayed */}
                  <div className="text-center">
                    <span className="block text-[8px] text-slate-500 font-black uppercase font-data tracking-wider">Delay</span>
                    <span className="text-xs font-black font-data text-slate-400">
                      {item.delayedCount || 0}
                    </span>
                  </div>

                  {/* Completed */}
                  <div className="text-center">
                    <span className="block text-[8px] text-slate-500 font-black uppercase font-data tracking-wider">Done</span>
                    <span className={cn(
                      "text-xs font-black font-data",
                      item.completedCount ? "text-emerald-400" : "text-slate-400"
                    )}>
                      {item.completedCount || 0}
                    </span>
                  </div>

                  {/* Failed */}
                  <div className="text-center">
                    <span className="block text-[8px] text-slate-500 font-black uppercase font-data tracking-wider">Fail</span>
                    <span className={cn(
                      "text-xs font-black font-data",
                      item.failedCount ? "text-rose-400 font-extrabold" : "text-slate-400"
                    )}>
                      {item.failedCount || 0}
                    </span>
                  </div>
                </div>

                {/* Realtime timing telemetry */}
                <div className="grid grid-cols-2 gap-2 text-[10px] font-data text-slate-400">
                  <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 px-2 py-1.5">
                    <div className="text-[8px] font-display uppercase tracking-wider text-slate-500 font-black">Current</div>
                    <div className="font-bold text-slate-200">{item.currentStatus || 'offline'}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 px-2 py-1.5">
                    <div className="text-[8px] font-display uppercase tracking-wider text-slate-500 font-black">Next Run (IST)</div>
                    <div className="font-bold text-indigo-300">{item.nextScheduledAt ? relFromIso(item.nextScheduledAt) : 'N/A'}</div>
                    <div className="text-[9px] text-slate-500">{fmtIstDateTime(item.nextScheduledAt)}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 px-2 py-1.5">
                    <div className="text-[8px] font-display uppercase tracking-wider text-slate-500 font-black">Last Success (IST)</div>
                    <div className="font-bold text-emerald-300">{relFromIso(item.lastSuccessAt)}</div>
                    <div className="text-[9px] text-slate-500">{fmtIstDateTime(item.lastSuccessAt)}</div>
                  </div>
                  <div className="rounded-lg border border-slate-800/60 bg-slate-950/30 px-2 py-1.5">
                    <div className="text-[8px] font-display uppercase tracking-wider text-slate-500 font-black">Typical Runtime</div>
                    <div className="font-bold text-slate-200">
                      p50 {fmtDuration(item.duration?.p50Ms)}
                      <span className="text-slate-500"> · p95 {fmtDuration(item.duration?.p95Ms)}</span>
                    </div>
                  </div>
                </div>

                {/* Footer trigger controls */}
                <div className="flex items-center justify-between pt-1">
                  <div className="text-[9px] text-slate-500 font-bold font-data uppercase whitespace-normal break-all pr-2">
                    ID: {item.id}
                  </div>

                  <button
                    disabled={!isConnected || isBusy}
                    onClick={() => handleTriggerJob(item.id)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-[10px] font-black font-display uppercase tracking-wider font-data flex items-center gap-1.5 transition-all cursor-pointer shadow-md select-none border",
                      isSuccess
                        ? "bg-emerald-600 border-emerald-500 text-white font-extrabold"
                        : isBusy
                        ? "bg-slate-900 border-slate-800 text-indigo-400"
                        : !isConnected
                        ? "bg-slate-950/20 border-slate-900 text-slate-600 cursor-not-allowed"
                        : "bg-indigo-600 border-indigo-500 hover:bg-indigo-500 hover:border-indigo-400 text-white"
                    )}
                  >
                    {isSuccess ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 animate-bounce" />
                        <span>QUEUED</span>
                      </>
                    ) : isBusy ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>DISPATCHING</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 shrink-0" />
                        <span>RUN NOW</span>
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>

        {filteredQueues.length === 0 && (
          <div className="text-center py-12 v1-card">
            <SlidersHorizontal className="w-8 h-8 text-slate-650 mx-auto mb-2" />
            <p className="text-xs text-slate-400 font-bold font-display uppercase tracking-widest">No matching queues configured</p>
          </div>
        )}
      </div>

      {/* ─── Recent Jobs logs table (Console-styled) ─── */}
      {!isRedisOffline && allRecentJobs.length > 0 && (
        <div className="glass rounded-2xl overflow-hidden shadow-xl border border-slate-800/80">
          
          <div className="p-4 bg-slate-950/30 border-b border-slate-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" />
              <h3 className="v1-title-section">
                System Job Execution Stream
              </h3>
            </div>
            <span className="text-[9px] font-black font-display uppercase tracking-wider text-slate-500 font-data">
              REAL-TIME BUFFER
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-850 text-[9px] font-black font-display uppercase tracking-wider text-slate-400 font-data bg-slate-950/15">
                  <th className="py-2.5 px-4">Time</th>
                  <th className="py-2.5 px-4">Category</th>
                  <th className="py-2.5 px-4">Queue Context</th>
                  <th className="py-2.5 px-4">Job Identifier</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Progress / Metrics</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {allRecentJobs.map((job) => {
                  const processedAt = fmtIstTime(job.processedOn ?? null);
                  const isFailed = job.state === 'failed';
                  const isActive = job.state === 'active';
                  const isExpanded = expandedJobId === job.id;
                  const catConfig = CATEGORIES.find(c => c.id === job.category) || CATEGORIES[0];

                  return (
                    <React.Fragment key={job.id}>
                      <tr className={cn(
                        "border-b border-slate-850 text-xs hover:bg-slate-900/20 font-data transition-colors",
                        isFailed ? "bg-rose-950/5" : isActive ? "bg-indigo-950/5" : ""
                      )}>
                        {/* Time */}
                        <td className="py-3 px-4 text-slate-400 font-bold whitespace-nowrap">
                          <div>{processedAt}</div>
                          {job.finishedOn ? (
                            <div className="text-[9px] text-slate-600">done {fmtIstTime(job.finishedOn)}</div>
                          ) : null}
                        </td>

                        {/* Category badge */}
                        <td className="py-3 px-4">
                          <span className={cn(
                            "text-[8px] font-black px-1.5 py-0.5 rounded font-data font-display uppercase tracking-wider border",
                            job.category === 'data-sync' ? "bg-emerald-950/40 text-emerald-400 border-emerald-500/20" :
                            job.category === 'signals-analysis' ? "bg-amber-950/40 text-amber-400 border-amber-500/20" :
                            job.category === 'machine-learning' ? "bg-violet-950/40 text-violet-400 border-violet-500/20" :
                            job.category === 'agents' ? "bg-sky-950/40 text-sky-400 border-sky-500/20" :
                            "bg-rose-950/40 text-rose-400 border-rose-500/20"
                          )}>
                            {catConfig.label.split(' ')[0]}
                          </span>
                        </td>

                        {/* Queue Name */}
                        <td className="py-3 px-4 text-slate-300 font-bold whitespace-normal break-words align-top">
                          {job.queueLabel}
                        </td>

                        {/* Job ID / Name */}
                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="font-black text-slate-200 text-[11px] whitespace-normal break-words leading-tight">
                              {job.name}
                            </span>
                            <span className="text-[9px] text-slate-500 font-bold">
                              ID: {job.id}
                            </span>
                          </div>
                        </td>

                        {/* State tag */}
                        <td className="py-3 px-4">
                          <span className={cn(
                            "text-[8px] font-black px-2 py-0.5 rounded-full font-data font-display uppercase tracking-widest border",
                            job.state === 'completed' ? "bg-emerald-950/40 border-emerald-500/20 text-emerald-400" :
                            job.state === 'failed' ? "bg-rose-950/40 border-rose-500/20 text-rose-400" :
                            job.state === 'active' ? "bg-indigo-950/40 border-indigo-500/20 text-indigo-400 animate-pulse" :
                            "bg-amber-950/40 border-amber-500/20 text-amber-400"
                          )}>
                            {job.state}
                          </span>
                        </td>

                        {/* Progress */}
                        <td className="py-3 px-4">
                          {isFailed ? (
                            <span className="text-[10px] text-rose-400 font-bold whitespace-normal break-words block leading-snug">
                              Err: {job.failedReason || 'Unknown error'}
                            </span>
                          ) : (
                            <div className="flex items-center gap-2 max-w-[150px]">
                              <div className="w-full bg-slate-900 rounded-full h-1.5 border border-slate-800">
                                <div
                                  className={cn(
                                    "h-full rounded-full transition-all duration-300",
                                    job.state === 'completed' ? "bg-emerald-500" : "bg-indigo-500"
                                  )}
                                  style={{ width: `${job.progress || (job.state === 'completed' ? 100 : 10)}%` }}
                                />
                              </div>
                              <span className="text-[9px] text-slate-400 font-bold">{job.progress || (job.state === 'completed' ? 100 : 0)}%</span>
                            </div>
                          )}
                        </td>

                        {/* Chevron Trigger details */}
                        <td className="py-3 px-4 text-right">
                          {isFailed ? (
                            <button
                              onClick={() => setExpandedJobId(isExpanded ? null : job.id)}
                              className="px-2.5 py-1 text-[9px] font-black font-display uppercase tracking-wider rounded border border-rose-500/20 bg-rose-950/20 text-rose-400 hover:bg-rose-500 hover:text-white transition-all flex items-center gap-1.5 ml-auto cursor-pointer"
                            >
                              <span>Traceback</span>
                              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </button>
                          ) : job.finishedOn && job.processedOn ? (
                            <span className="text-[10px] text-slate-500 font-bold font-data">
                              {((job.finishedOn - job.processedOn) / 1000).toFixed(2)}s
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-500 font-data">—</span>
                          )}
                        </td>
                      </tr>

                      {/* Monospace Error logs Traceback row */}
                      <AnimatePresence>
                        {isFailed && isExpanded && (
                          <tr>
                            <td colSpan={7} className="p-0 border-b border-slate-850">
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden bg-slate-950/70"
                              >
                                <div className="p-4.5 font-data text-[10px] text-rose-300 leading-relaxed border-t border-rose-500/10 space-y-2">
                                  <div className="flex items-center gap-2 text-rose-400 font-black border-b border-rose-500/10 pb-2">
                                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                                    <span>CRITICAL QUEUE EXCEPTION TRACEBACK FOR JOB: {job.id}</span>
                                  </div>
                                  <pre className="whitespace-pre-wrap select-all font-data py-2 text-slate-300 leading-normal max-h-48 overflow-y-auto hide-scrollbar">
                                    {job.failedReason || 'No traceback logs returned from parent worker thread.'}
                                  </pre>
                                  <p className="text-[9px] text-rose-400/60 font-black">
                                    Execution Failed On: {job.finishedOn ? new Date(job.finishedOn).toString() : 'N/A'}
                                  </p>
                                </div>
                              </motion.div>
                            </td>
                          </tr>
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
