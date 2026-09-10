// vendored from LP-hedging-strategy/lp-monitor/src/utils/logger.ts @ git aacfe017291681164a1a23b756f4516768699ad0
// co-maintained; strip = console transport moved to STDERR (opms-spec §5:
// stdout is the protocol channel), file path roots in this project's
// EXECUTOR_LOG_DIR via config injection instead of LP_HEDGE_LOG_DIR/`../logs`.
// Delta (M0 review): idempotent transport setup; all levels go to stderr.
// Do not edit in place without noting the delta here.

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
