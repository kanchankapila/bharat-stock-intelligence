import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import util from 'util';

// Ensure logs directory exists
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Custom format for console
const consoleFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${stack || message}`;
  // Avoid printing the service name all the time in the console
  const metaClone = { ...metadata };
  delete metaClone.service;
  if (Object.keys(metaClone).length > 0) {
    msg += ` ${JSON.stringify(metaClone)}`;
  }
  return msg;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    json()
  ),
  defaultMeta: { service: 'bharat-stock-intelligence' },
  transports: [
    new DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '14d',
      zippedArchive: true,
    }),
    new DailyRotateFile({
      filename: path.join(logDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    }),
  ],
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
    })
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
    })
  ]
});

// Always log to console as well
logger.add(new winston.transports.Console({
  format: combine(
    colorize(),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    consoleFormat
  )
}));

// Wrapper to maintain backward compatibility with existing code
const log = {
  info:  (msg: string, ctx?: Record<string, unknown>) => logger.info(msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => logger.warn(msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => logger.error(msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => logger.debug(msg, ctx),
};

// Every `console.log`/`error`/`warn` call across ~140 server files bypasses `log` above
// entirely (611 raw call sites at last count, 2026-08-05 audit) -- no level, no JSON file
// persistence, no rotation. Rewriting 611 call sites by hand is its own multi-session project;
// this instead routes the *existing* console.* API through the real logger, so every call site
// gets structured JSON output (logs/app-*.log, logs/error-*.log) and a real level for free,
// with zero code changes required at any of them. New code should still prefer calling `log`
// directly when the event is worth structured fields beyond a formatted string (see the
// server.ts internalAuth gate-rejection calls for the pattern) -- this shim's job is to stop
// the other 611 sites from being invisible to log-level filtering, not to be the final form of
// logging in this codebase.
type ConsoleTarget = Pick<typeof logger, 'info' | 'warn' | 'error' | 'debug'>;

const IOREDIS_ACL_NOISE = 'does not require a password';

/**
 * Redirects console.log/info/debug/warn/error through `target` (the real winston logger by
 * default). Multi-arg calls are flattened with the same `util.format` semantics console.log
 * itself uses, so `console.log('foo', 42, {bar:1})` still reads the way it always did -- now
 * also written to logs/app-*.log with a level and timestamp.
 *
 * Returns a restore function that undoes the patch. Tests MUST call it (or pass a fake
 * `target`) -- this repo's vitest config runs every test file in a single shared process
 * (`singleFork: true`), so an un-restored console patch leaks into every test file that runs
 * afterward in the same run.
 */
export function installStructuredConsole(target: ConsoleTarget = logger): () => void {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  console.log = (...args: unknown[]) => target.info(util.format(...args));
  console.info = (...args: unknown[]) => target.info(util.format(...args));
  console.debug = (...args: unknown[]) => target.debug(util.format(...args));
  console.error = (...args: unknown[]) => target.error(util.format(...args));
  console.warn = (...args: unknown[]) => {
    const msg = util.format(...args);
    // Cosmetic ioredis WARN about Redis 7 + requirepass ACL mismatch -- logged by every one of
    // the ~88 BullMQ connections on startup; auth still works. Was a standalone console.warn
    // override in server.ts before this shim existed; folded in here so there's exactly one
    // place patching console.warn, not two competing ones.
    if (msg.includes(IOREDIS_ACL_NOISE)) return;
    target.warn(msg);
  };

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.warn = original.warn;
    console.error = original.error;
  };
}

export default log;
export { logger };
