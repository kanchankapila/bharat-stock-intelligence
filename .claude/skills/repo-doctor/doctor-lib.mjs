const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function localDateKey(localUtcDate) {
  const y = localUtcDate.getUTCFullYear();
  const m = String(localUtcDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(localUtcDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Latest NSE intraday slot that should have completed by now.
 *
 * Dates are evaluated in fixed Asia/Kolkata time (India has no DST), weekends and recorded NSE
 * holidays are excluded, and a grace window keeps an occurrence from becoming late while its
 * worker can still be finishing. Returning the actual due epoch lets the doctor compare the
 * heartbeat directly instead of applying a calendar-hour threshold across closed days.
 */
export function latestExpectedNseIntradaySlot(
  now,
  holidayDates = [],
  {
    openHour = 9,
    openMinute = 30,
    closeHour = 15,
    closeMinute = 30,
    intervalMinutes = 15,
    graceMinutes = 20,
    lookbackDays = 35,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid Date or epoch');

  const holidays = new Set(holidayDates.map(String));
  const localNow = new Date(nowMs + IST_OFFSET_MS);
  const localTodayMs = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
  );
  const eligibleThrough = nowMs - graceMinutes * 60_000;
  const firstSlotMinute = openHour * 60 + openMinute;
  const lastSlotMinute = closeHour * 60 + closeMinute;
  let latest = null;

  for (let offset = lookbackDays; offset >= 0; offset -= 1) {
    const localDay = new Date(localTodayMs - offset * DAY_MS);
    const weekday = localDay.getUTCDay();
    if (weekday === 0 || weekday === 6 || holidays.has(localDateKey(localDay))) continue;

    for (let minute = firstSlotMinute; minute <= lastSlotMinute; minute += intervalMinutes) {
      const slotMs = Date.UTC(
        localDay.getUTCFullYear(),
        localDay.getUTCMonth(),
        localDay.getUTCDate(),
        Math.floor(minute / 60),
        minute % 60,
      ) - IST_OFFSET_MS;
      if (slotMs <= eligibleThrough) latest = slotMs;
    }
  }
  return latest;
}

/** Latest weekday NSE job run whose own completion grace has elapsed. */
export function latestExpectedNseDailyRun(
  now,
  holidayDates = [],
  {
    hourUtc,
    minuteUtc = 0,
    graceMinutes = 0,
    lookbackDays = 35,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid Date or epoch');
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new TypeError('hourUtc must be an integer from 0 to 23');
  }

  const holidays = new Set(holidayDates.map(String));
  const localNow = new Date(nowMs + IST_OFFSET_MS);
  const localTodayMs = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
  );
  let latest = null;

  for (let offset = lookbackDays; offset >= 0; offset -= 1) {
    const localDay = new Date(localTodayMs - offset * DAY_MS);
    const weekday = localDay.getUTCDay();
    if (weekday === 0 || weekday === 6 || holidays.has(localDateKey(localDay))) continue;
    const runMs = Date.UTC(
      localDay.getUTCFullYear(),
      localDay.getUTCMonth(),
      localDay.getUTCDate(),
      hourUtc,
      minuteUtc,
    );
    if (runMs + graceMinutes * 60_000 <= nowMs) latest = runMs;
  }
  return latest;
}

/** NSE session date whose first intraday slot is already due, in YYYY-MM-DD. */
export function latestNseSessionDate(now, holidayDates = []) {
  const slotMs = latestExpectedNseIntradaySlot(now, holidayDates);
  if (slotMs == null) return null;
  return localDateKey(new Date(slotMs + IST_OFFSET_MS));
}

/**
 * Only signatures demonstrated to be transient are suppressed in the 48-hour summary.
 * A provider name, HTTP 404, or generic "steps failed" text is not evidence of recovery.
 */
export function isKnownTransientFailure(message) {
  const text = String(message || '');
  return /waf|captcha|429|execution budget|failed to send|Live Market Screener.*(?:timeout|aborted)|niftytrader.*(?:timeout|aborted|unauthorized|403)|trendlyne.*(?:timeout|aborted|waf|captcha)|marketsmojo.*(?:timeout|aborted|rate.?limit)|(?:connection|server) (?:closed|reset).*unexpectedly/i.test(text);
}

/** Failures still requiring action: neither a known transient nor followed by a success. */
export function unrecoveredFailureRows(rows) {
  return rows.filter(row => !row.recovered && !isKnownTransientFailure(row.err));
}

const EVIDENCE_LANE_DQ = new Set(['ur-engine-dispersion-collapse']);

/** Keep known no-edge evidence visible without letting it mask an unrelated hard DQ failure. */
export function classifyLatestDq(rows) {
  const failing = rows.filter(row => row.status === 'fail' || row.status === 'error');
  const blocking = failing.filter(row => !EVIDENCE_LANE_DQ.has(row.check_id));
  const counts = new Map();
  for (const row of rows) {
    const current = counts.get(row.status) || { n: 0, crit: 0 };
    current.n += 1;
    if (Number(row.critical)) current.crit += 1;
    counts.set(row.status, current);
  }
  const summary = [...counts.entries()]
    .map(([status, count]) => `${status}=${count.n}${count.crit ? `(crit ${count.crit})` : ''}`)
    .join(' / ');
  if (blocking.length) {
    return { status: 'FAIL', detail: `${summary}; blocking: ${blocking.map(row => row.check_id).join(', ')}` };
  }
  if (failing.length) {
    return {
      status: 'WARN',
      detail: `${summary}; evidence-lane: ${failing.map(row => row.check_id).join(', ')}`,
    };
  }
  return { status: 'PASS', detail: summary };
}
