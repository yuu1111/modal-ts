/**
 * Log severity level
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Numeric mapping for log levels
 */
const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Logger interface
 */
export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/**
 * Parses and normalizes a log level string
 * @param level - Log level string; an empty string maps to "warn"
 * @returns Normalized log level
 * @throws When the log level value is invalid
 */
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

/**
 * Default logger implementation that filters by level
 */
export class DefaultLogger implements Logger {
	private levelValue: number;

	constructor(level: LogLevel = "warn") {
		this.levelValue = LOG_LEVELS[level];
	}

	debug(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.debug) {
			console.log(this.formatMessage("DEBUG", message, args));
		}
	}

	info(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.info) {
			console.log(this.formatMessage("INFO", message, args));
		}
	}

	warn(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.warn) {
			console.warn(this.formatMessage("WARN", message, args));
		}
	}

	error(message: string, ...args: unknown[]): void {
		if (this.levelValue <= LOG_LEVELS.error) {
			console.error(this.formatMessage("ERROR", message, args));
		}
	}

	private formatMessage(
		level: string,
		message: string,
		args: unknown[],
	): string {
		const timestamp = new Date().toISOString();
		let formatted = `${timestamp} [${level}] ${message}`;
		for (let i = 0; i < args.length; i += 2) {
			const key = args[i];
			const value = args[i + 1];
			formatted += ` ${key}=${this.formatValue(value)}`;
		}
		return formatted;
	}

	private formatValue(value: unknown): string {
		if (value === null || value === undefined) {
			return String(value);
		}
		if (typeof value === "string") {
			return value;
		}
		if (value instanceof Error) {
			return value.message;
		}
		return String(value);
	}
}

/**
 * Wrapper that adds level filtering to an existing logger
 */
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

/**
 * Creates a logger, wrapping an existing logger with filtering or using the default
 * @param logger - Logger to wrap
 * @param logLevel - Log level string @default ""
 * @returns Configured logger
 */
export function createLogger(logger?: Logger, logLevel: string = ""): Logger {
	const level = parseLogLevel(logLevel);

	if (logger) {
		return new FilteredLogger(logger, level);
	}

	return new DefaultLogger(level);
}

/**
 * Creates a new default logger
 * @param logLevel - Log level string @default ""
 * @returns Default logger
 */
export function newLogger(logLevel: string = ""): Logger {
	return createLogger(undefined, logLevel);
}
