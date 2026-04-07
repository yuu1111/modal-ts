/* eslint-disable no-console */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

export function parseLogLevel(level: string): LogLevel {
	if (!level) {
		return "warn";
	}

	const normalized = level.toLowerCase();
	if (
		normalized === "debug" ||
		normalized === "info" ||
		normalized === "warn" ||
		normalized === "warning" ||
		normalized === "error"
	) {
		return normalized === "warning" ? "warn" : (normalized as LogLevel);
	}

	throw new Error(
		`Invalid log level value: "${level}" (must be debug, info, warn, or error)`,
	);
}

export class DefaultLogger implements Logger {
	private levelValue: number;

	constructor(level: LogLevel = "warn") {
		this.levelValue = LOG_LEVELS[level];
	}

	debug(_message: string, ..._args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.debug) {
		}
	}

	info(_message: string, ..._args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.info) {
		}
	}

	warn(_message: string, ..._args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.warn) {
		}
	}

	error(_message: string, ..._args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.error) {
		}
	}
}

class FilteredLogger implements Logger {
	private levelValue: number;

	constructor(
		private logger: Logger,
		level: LogLevel,
	) {
		this.levelValue = LOG_LEVELS[level];
	}

	debug(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.debug) {
			this.logger.debug(message, ...args);
		}
	}

	info(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.info) {
			this.logger.info(message, ...args);
		}
	}

	warn(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.warn) {
			this.logger.warn(message, ...args);
		}
	}

	error(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.error) {
			this.logger.error(message, ...args);
		}
	}
}

export function createLogger(logger?: Logger, logLevel: string = ""): Logger {
	const level = parseLogLevel(logLevel);

	if (logger) {
		return new FilteredLogger(logger, level);
	}

	return new DefaultLogger(level);
}

export function newLogger(logLevel: string = ""): Logger {
	return createLogger(undefined, logLevel);
}
