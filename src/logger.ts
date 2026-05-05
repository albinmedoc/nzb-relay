import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    base: undefined
  });
}

