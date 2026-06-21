import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

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

export default log;
export { logger };
