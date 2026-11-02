import winston from 'winston';
import path from 'path';
// the server's log redaction (e-mails, phones, tokens, connection strings), also for the log files
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { redact } = require('../../../utils/logSafety');

const redactFields = winston.format((info) => {
  for (const k of Object.keys(info)) if (typeof info[k] === 'string') info[k] = redact(info[k]);
  return info;
});

// Resolve log folder relative to current working directory (project root)
const logDirectory = path.resolve('logs');

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  redactFields(),
  winston.format.json()
);

const transports = [
  new winston.transports.Console({
    level: 'warn',
    format: winston.format.combine(
      winston.format.colorize({ all: true }),
      winston.format.printf(
        (info) => `[${info.timestamp}] [${info.level}]: ${info.message}`
      )
    ),
  }),
  new winston.transports.File({
    filename: path.join(logDirectory, 'error.log'),
    level: 'error',
  }),
  new winston.transports.File({
    filename: path.join(logDirectory, 'combined.log'),
  }),
];

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  levels,
  format,
  transports,
});

export default logger;
