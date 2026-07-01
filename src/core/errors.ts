/**
 * @description Modal SDK エラーの基底クラス。サブクラスの名前を自動設定する
 */
export class ModalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * @description 操作が許容時間を超過した
 */
export class TimeoutError extends ModalError {
	constructor(message = "Operation timed out") {
		super(message);
	}
}

/**
 * @description Function実行が許容時間を超過した
 */
export class FunctionTimeoutError extends ModalError {}

/**
 * @description Modalサーバーエラー、またはPython例外
 */
export class RemoteError extends ModalError {}

/**
 * @description リトライ可能なModal内部エラー
 */
export class InternalFailure extends ModalError {}

/**
 * @description リソースが見つからない
 */
export class NotFoundError extends ModalError {}

/**
 * @description リソースが既に存在する
 */
export class AlreadyExistsError extends ModalError {}

/**
 * @description リクエストまたは操作が不正
 */
export class InvalidError extends ModalError {}

/**
 * @description Queueが空
 */
export class QueueEmptyError extends ModalError {}

/**
 * @description Queueが満杯
 */
export class QueueFullError extends ModalError {}

/**
 * @description 不正なSandbox FileSystem操作
 */
export class SandboxFilesystemError extends ModalError {}

/**
 * @description Sandbox filesystem のパスが見つからない
 */
export class SandboxFilesystemNotFoundError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem のディレクトリが空ではない
 */
export class SandboxFilesystemDirectoryNotEmptyError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem の対象がディレクトリ
 */
export class SandboxFilesystemIsADirectoryError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem の対象がディレクトリではない
 */
export class SandboxFilesystemNotADirectoryError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem の操作権限がない
 */
export class SandboxFilesystemPermissionError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem のファイルサイズが大きすぎる
 */
export class SandboxFilesystemFileTooLargeError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem のパスが既に存在する
 */
export class SandboxFilesystemPathAlreadyExistsError extends SandboxFilesystemError {}

/**
 * @description Sandbox操作が許容時間を超過した
 */
export class SandboxTimeoutError extends ModalError {
	constructor(message = "Sandbox operation timed out") {
		super(message);
	}
}

/**
 * @description デタッチされたSandboxへの操作を試みた
 */
export class ClientClosedError extends ModalError {
	constructor(message = "Unable to perform operation on a detached sandbox") {
		super(message);
	}
}
