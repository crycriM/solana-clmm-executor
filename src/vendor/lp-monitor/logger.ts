// Read-only logging adapter. Console output is sent to STDERR so STDOUT
// remains reserved for the JSON-lines protocol; file paths are supplied by
// executor configuration. The transport setup is idempotent.

import winston from 'winston';
import { TransformableInfo } from 'logform';

const LINE_FORMAT = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss,SSS' }),
  winston.format.printf((info: TransformableInfo) => {
    const message = typeof info.message === 'string' ? info.message : String(info.message);
    return `${info.timestamp} - main - ${info.level.toUpperCase()} - ${message}`;
  }),
);

/**
 * Only redacted messages from log.ts reach this logger. Its default stderr
 * transport also reports startup errors before a log directory is available.
 */
export const logger = winston.createLogger({
  level: 'info',
  format: LINE_FORMAT,
  transports: [
    new winston.transports.Console({
      stderrLevels: Object.keys(winston.config.npm.levels),
    }),
  ],
});

/**
 * Attach transports after config is known; repeated calls do not duplicate
 * logging or remove stderr accidentally.
 */
export function initLogger(logDir: string, console_ = true): void {
  for (const transport of [...logger.transports]) {
    logger.remove(transport);
    transport.close?.();
  }
  logger.add(
    new winston.transports.File({
      filename: `${logDir}/executor.log`,
      maxsize: 5242880,
      maxFiles: 5,
      format: LINE_FORMAT,
    }),
  );
  if (console_) {
    logger.add(
      new winston.transports.Console({
        stderrLevels: Object.keys(winston.config.npm.levels),
        format: LINE_FORMAT,
      }),
    );
  }
}
