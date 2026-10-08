import { JOB_REGISTRY } from './jobRegistry';
import { MONITOR_SCRIPTS } from './monitorScripts';

export interface JobReadinessEntry {
  jobName: string;
  label: string;
  critical: boolean;
  scheduled: boolean;
  cronPatterns?: string[];
  everyMs?: number;
  graceMinutes: number;
  staleLimitHours?: number;
  source: 'JOB_REGISTRY' | 'MONITOR_SCRIPTS';
}

/** One de-duplicated view of every job/check covered by either monitoring registry. */
export function buildJobReadinessRegistry(): JobReadinessEntry[] {
  const entries = new Map<string, JobReadinessEntry>();
  for (const job of JOB_REGISTRY) {
    const cronPatterns = job.lateDeadlineCronPatterns?.length
      ? [...job.lateDeadlineCronPatterns]
      : job.cronPattern ? [job.cronPattern] : undefined;
    entries.set(job.jobName, {
      jobName: job.jobName,
      label: job.label,
      critical: !!job.critical,
      scheduled: !!(job.cronPattern || job.everyMs),
      cronPatterns,
      everyMs: job.everyMs,
      graceMinutes: job.graceMinutes,
      source: 'JOB_REGISTRY',
    });
  }

  for (const monitor of MONITOR_SCRIPTS as readonly any[]) {
    if (entries.has(monitor.id)) continue;
    entries.set(monitor.id, {
      jobName: monitor.id,
      label: monitor.label,
      critical: !!monitor.critical,
      scheduled: true,
      cronPatterns: monitor.cronPatterns?.length ? [...monitor.cronPatterns] : undefined,
      graceMinutes: Number(monitor.graceMinutes ?? 60),
      staleLimitHours: Number(monitor.staleLimitHours),
      source: 'MONITOR_SCRIPTS',
    });
  }
  return [...entries.values()];
}
