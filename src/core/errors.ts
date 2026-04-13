import { ClientError, Status } from "nice-grpc";

/**
 * @description gRPC の NOT_FOUND/FAILED_PRECONDITION を NotFoundError に変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param message - NotFoundError に使うメッセージ。省略時は err.details を使用
 * @param alsoNotFoundPatterns - FAILED_PRECONDITION の details にこのパターンが含まれていれば NotFoundError として扱う
 */
export function rethrowNotFound(
	err: unknown,
	message?: string,
	...alsoNotFoundPatterns: string[]
): never {
	if (err instanceof ClientError) {
		if (err.code === Status.NOT_FOUND)
			throw new NotFoundError(message ?? err.details);
		if (
			err.code === Status.FAILED_PRECONDITION &&
			alsoNotFoundPatterns.some((p) => err.details.includes(p))
		)
			throw new NotFoundError(message ?? err.details);
	}
	throw err;
}

/**
 * @description NOT_FOUND を allowMissing で抑制する。allowMissing でなければ再スローする
 * @param err - catch されたエラー
 * @param allowMissing - true なら NOT_FOUND を無視する
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

/**
 * @description 操作が許容時間を超過した
 */
export class TimeoutError extends Error {
	constructor(message: string = "Operation timed out") {
		super(message);
		this.name = "TimeoutError";
	}
}

/**
 * @description Function実行が許容時間を超過した
 */
export class FunctionTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FunctionTimeoutError";
	}
}

/**
 * @description Modalサーバーエラー、またはPython例外
 */
export class RemoteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteError";
	}
}

/**
 * @description リトライ可能なModal内部エラー
 */
export class InternalFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InternalFailure";
	}
}

/**
 * @description リソースが見つからない
 */
export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}

/**
 * @description リソースが既に存在する
 */
export class AlreadyExistsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AlreadyExistsError";
	}
}

/**
 * @description リクエストまたは操作が不正
 */
export class InvalidError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidError";
	}
}

/**
 * @description Queueが空
 */
export class QueueEmptyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QueueEmptyError";
	}
}

/**
 * @description Queueが満杯
 */
export class QueueFullError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QueueFullError";
	}
}

/**
 * @description 不正なSandbox FileSystem操作
 */
export class SandboxFilesystemError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxFilesystemError";
	}
}

/**
 * @description Sandbox操作が許容時間を超過した
 */
export class SandboxTimeoutError extends Error {
	constructor(message: string = "Sandbox operation timed out") {
		super(message);
		this.name = "SandboxTimeoutError";
	}
}

/**
 * @description デタッチされたSandboxへの操作を試みた
 */
export class ClientClosedError extends Error {
	constructor(
		message: string = "Unable to perform operation on a detached sandbox",
	) {
		super(message);
		this.name = "ClientClosedError";
	}
}
