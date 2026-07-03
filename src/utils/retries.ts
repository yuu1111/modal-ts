import { InvalidError } from "@/core/errors";

/**
 * @description Retry policy settings for Modal Function and Cls
 * @property maxRetries - Maximum number of retries (0-10)
 * @property backoffCoefficient - Backoff coefficient @defaultValue 2.0
 * @property initialDelayMs - Initial retry delay @defaultValue 1000
 * @property maxDelayMs - Maximum retry delay @defaultValue 60000
 */
export class Retries {
	readonly maxRetries: number;
	readonly backoffCoefficient: number;
	readonly initialDelayMs: number;
	readonly maxDelayMs: number;

	/**
	 * @description Constructs a retry policy
	 * @param params - Retry settings
	 */
	constructor(params: {
		maxRetries: number;
		backoffCoefficient?: number;
		initialDelayMs?: number;
		maxDelayMs?: number;
	}) {
		const {
			maxRetries,
			backoffCoefficient = 2.0,
			initialDelayMs = 1000,
			maxDelayMs = 60000,
		} = params;

		if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
			throw new InvalidError(
				`Invalid maxRetries: ${maxRetries}. Must be an integer between 0 and 10.`,
			);
		}

		if (backoffCoefficient < 1.0 || backoffCoefficient > 10.0) {
			throw new InvalidError(
				`Invalid backoffCoefficient: ${backoffCoefficient}. Must be between 1.0 and 10.0`,
			);
		}

		if (initialDelayMs < 0 || initialDelayMs > 60000) {
			throw new InvalidError(
				`Invalid initialDelayMs: ${initialDelayMs}. Must be between 0 and 60000 ms.`,
			);
		}

		if (maxDelayMs < 1000 || maxDelayMs > 60000) {
			throw new InvalidError(
				`Invalid maxDelayMs: ${maxDelayMs}. Must be between 1000 and 60000 ms.`,
			);
		}

		this.maxRetries = maxRetries;
		this.backoffCoefficient = backoffCoefficient;
		this.initialDelayMs = initialDelayMs;
		this.maxDelayMs = maxDelayMs;
	}
}

/**
 * @description Normalizes retry settings, converting numbers into Retries instances
 * @param retries - Retry count or Retries instance
 * @returns Normalized Retries, or undefined if omitted
 */
export function parseRetries(
	retries: number | Retries | undefined,
): Retries | undefined {
	if (retries === undefined) return undefined;
	if (typeof retries === "number") {
		return new Retries({
			maxRetries: retries,
			backoffCoefficient: 1.0,
			initialDelayMs: 1000,
		});
	}
	if (retries instanceof Retries) return retries;
	throw new InvalidError(
		`Retries parameter must be an integer or instance of Retries. Found: ${typeof retries}.`,
	);
}
