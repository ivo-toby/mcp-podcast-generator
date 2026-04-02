import pino from 'pino';
import pretty from 'pino-pretty';

const stream = pretty({
  colorize: true,
  translateTime: 'SYS:HH:MM:ss',
  ignore: 'pid,hostname',
  messageFormat: '[{module}] {msg}',
});

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  stream
);

export function childLogger(name: string) {
  return logger.child({ module: name });
}
