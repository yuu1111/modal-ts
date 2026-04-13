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
