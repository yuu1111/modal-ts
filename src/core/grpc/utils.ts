import { ClientError, type ClientMiddleware, Status } from "nice-grpc";

/**
 * @description Timeout settings for gRPC calls
 * @property timeoutMs - Timeout in milliseconds @optional
 */
export type TimeoutOptions = {
	timeoutMs?: number;
};

/**
 * @description Middleware that applies timeouts to gRPC calls
 */
export const timeoutMiddleware: ClientMiddleware<TimeoutOptions> =
	async function* timeoutMiddleware(call, options) {
		if (!options.timeoutMs || options.signal?.aborted) {
			return yield* call.next(call.request, options);
		}

		const { timeoutMs, signal: origSignal, ...restOptions } = options;
		const abortController = new AbortController();
		const abortListener = () => abortController.abort();
		origSignal?.addEventListener("abort", abortListener);

		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			abortController.abort();
		}, timeoutMs);

		try {
			return yield* call.next(call.request, {
				...restOptions,
				signal: abortController.signal,
			});
		} catch (err) {
			if (timedOut) {
				throw new ClientError(
					call.method.path,
					Status.DEADLINE_EXCEEDED,
					`Timed out after ${timeoutMs}ms`,
				);
			}
			throw err;
		} finally {
			origSignal?.removeEventListener("abort", abortListener);
			clearTimeout(timer);
		}
	};

/**
 * @description gRPC status codes eligible for retry
 */
export const retryableGrpcStatusCodes = new Set([
	Status.DEADLINE_EXCEEDED,
	Status.UNAVAILABLE,
	Status.CANCELLED,
	Status.INTERNAL,
	Status.UNKNOWN,
]);

/**
 * @description Checks whether an error has a retryable gRPC status code
 * @param err - Error to check
 * @returns true when retryable
 */
export function isRetryableGrpc(err: unknown) {
	if (err instanceof ClientError) {
		return retryableGrpcStatusCodes.has(err.code);
	}
	return false;
}

/**
 * @description Sleep that can be cancelled with an AbortSignal
 * @param ms - Wait duration in milliseconds
 * @param signal - Cancellation signal @optional
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

/**
 * @description Behavior settings for gRPC retries
 * @property retries - Number of retries @optional @defaultValue 3
 * @property baseDelay - Initial delay in milliseconds @optional @defaultValue 100
 * @property maxDelay - Maximum delay in milliseconds @optional @defaultValue 1000
 * @property delayFactor - Exponential backoff multiplier @optional @defaultValue 2
 * @property additionalStatusCodes - Additional status codes to retry @optional
 */
export type RetryOptions = {
	retries?: number;
	baseDelay?: number;
	maxDelay?: number;
	delayFactor?: number;
	additionalStatusCodes?: Status[];
};
