/**
 * @description Base class for Modal SDK errors. Automatically sets the subclass name
 */
export class ModalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * @description The operation exceeded the allowed time
 */
export class TimeoutError extends ModalError {
	constructor(message = "Operation timed out") {
		super(message);
	}
}

/**
 * @description Function execution exceeded the allowed time
 */
export class FunctionTimeoutError extends ModalError {}

/**
 * @description Modal server error or Python exception
 */
export class RemoteError extends ModalError {}

/**
 * @description Retryable internal Modal error
 */
export class InternalFailure extends ModalError {}

/**
 * @description Resource was not found
 */
export class NotFoundError extends ModalError {}

/**
 * @description Resource already exists
 */
export class AlreadyExistsError extends ModalError {}

/**
 * @description Request or operation is invalid
 */
export class InvalidError extends ModalError {}

/**
 * @description Queue is empty
 */
export class QueueEmptyError extends ModalError {}

/**
 * @description Queue is full
 */
export class QueueFullError extends ModalError {}

/**
 * @description Invalid Sandbox filesystem operation
 */
export class SandboxFilesystemError extends ModalError {}

/**
 * @description Sandbox filesystem path was not found
 */
export class SandboxFilesystemNotFoundError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem directory is not empty
 */
export class SandboxFilesystemDirectoryNotEmptyError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem target is a directory
 */
export class SandboxFilesystemIsADirectoryError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem target is not a directory
 */
export class SandboxFilesystemNotADirectoryError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem operation is not permitted
 */
export class SandboxFilesystemPermissionError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem file is too large
 */
export class SandboxFilesystemFileTooLargeError extends SandboxFilesystemError {}

/**
 * @description Sandbox filesystem path already exists
 */
export class SandboxFilesystemPathAlreadyExistsError extends SandboxFilesystemError {}

/**
 * @description Sandbox operation exceeded the allowed time
 */
export class SandboxTimeoutError extends ModalError {
	constructor(message = "Sandbox operation timed out") {
		super(message);
	}
}

/**
 * @description An operation was attempted on a detached sandbox
 */
export class ClientClosedError extends ModalError {
	constructor(message = "Unable to perform operation on a detached sandbox") {
		super(message);
	}
}
