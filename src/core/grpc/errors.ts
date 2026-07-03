import { ClientError, Status } from "nice-grpc";
import { AlreadyExistsError, InvalidError, NotFoundError } from "@/core/errors";

/**
 * Shared options for rethrow functions
 * @property message - Error message. Uses err.details || err.message when omitted
 * @property preconditionPatterns - Conditions for converting FAILED_PRECONDITION too. An empty array means unconditional; a string array converts only when details include a pattern
 */
export interface RethrowOptions {
	message?: string;
	preconditionPatterns?: string[];
}

/**
 * Converts a gRPC status code to a domain error and rethrows it.
 * Rethrows the original error unchanged when it does not match.
 * @param err - Caught error
 * @param ErrorClass - Error class to throw
 * @param primaryStatus - Primary gRPC status code to match
 * @param options - Message and precondition settings
 */
function rethrowGrpc(
	err: unknown,
	ErrorClass: new (message: string) => Error,
	primaryStatus: Status,
	{ message, preconditionPatterns }: RethrowOptions,
): never {
	if (err instanceof ClientError) {
		const msg = message ?? (err.details || err.message);
		if (err.code === primaryStatus) throw new ErrorClass(msg);
		if (
			err.code === Status.FAILED_PRECONDITION &&
			preconditionPatterns &&
			(preconditionPatterns.length === 0 ||
				preconditionPatterns.some((p) => err.details.includes(p)))
		)
			throw new ErrorClass(msg);
	}
	throw err;
}

/**
 * Normalizes a string or options object into RethrowOptions
 * @param messageOrOptions - Message string or options object
 */
function resolveOptions(
	messageOrOptions: string | RethrowOptions | undefined,
): RethrowOptions {
	if (typeof messageOrOptions === "string")
		return { message: messageOrOptions };
	return messageOrOptions ?? {};
}

/**
 * Converts gRPC NOT_FOUND to NotFoundError and rethrows it.
 * Rethrows the original error unchanged when it does not match.
 * @param err - Caught error
 * @param messageOrOptions - Message string or options object
 */
export function rethrowNotFound(
	err: unknown,
	messageOrOptions?: string | RethrowOptions,
): never {
	rethrowGrpc(
		err,
		NotFoundError,
		Status.NOT_FOUND,
		resolveOptions(messageOrOptions),
	);
}

/**
 * Converts gRPC INVALID_ARGUMENT to InvalidError and rethrows it.
 * Rethrows the original error unchanged when it does not match.
 * @param err - Caught error
 * @param messageOrOptions - Message string or options object
 */
export function rethrowInvalid(
	err: unknown,
	messageOrOptions?: string | RethrowOptions,
): never {
	rethrowGrpc(
		err,
		InvalidError,
		Status.INVALID_ARGUMENT,
		resolveOptions(messageOrOptions),
	);
}

/**
 * Converts gRPC ALREADY_EXISTS to AlreadyExistsError and rethrows it.
 * Rethrows the original error unchanged when it does not match.
 * @param err - Caught error
 * @param messageOrOptions - Message string or options object
 */
export function rethrowAlreadyExists(
	err: unknown,
	messageOrOptions?: string | RethrowOptions,
): never {
	rethrowGrpc(
		err,
		AlreadyExistsError,
		Status.ALREADY_EXISTS,
		resolveOptions(messageOrOptions),
	);
}

/**
 * Suppresses NOT_FOUND when allowMissing is true. Otherwise rethrows
 * @param err - Caught error
 * @param allowMissing - When true, ignores NOT_FOUND
 */
export function suppressNotFound(
	err: unknown,
	allowMissing: boolean | undefined,
): void {
	const isNotFound =
		err instanceof NotFoundError ||
		(err instanceof ClientError && err.code === Status.NOT_FOUND);
	if (isNotFound && allowMissing) return;
	throw err;
}
