type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const entry = JSON.stringify({ level, msg, ...ctx, ts: Date.now() });
  if (level === 'ERROR') console.error(entry);
  else if (level === 'WARN') console.warn(entry);
  else console.log(entry);
}

const log = {
  info:  (msg: string, ctx?: Record<string, unknown>) => write('INFO',  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => write('WARN',  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write('ERROR', msg, ctx),
  debug: (msg: string, ctx?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === 'debug') write('DEBUG', msg, ctx);
  },
};

export default log;
