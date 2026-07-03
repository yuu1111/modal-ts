/**
 * Base class for Modal SDK errors. Automatically sets the subclass name
 */
export class ModalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * The operation exceeded the allowed time
 */
export class TimeoutError extends ModalError {
	constructor(message = "Operation timed out") {
		super(message);
	}
}

/**
 * Function execution exceeded the allowed time
 */
export class FunctionTimeoutError extends ModalError {}

/**
 * Modal server error or Python exception
 */
export class RemoteError extends ModalError {}

/**
 * Retryable internal Modal error
 */
export class InternalFailure extends ModalError {}

/**
 * Resource was not found
 */
export class NotFoundError extends ModalError {}

/**
 * Resource already exists
 */
export class AlreadyExistsError extends ModalError {}

/**
 * Request or operation is invalid
 */
export class InvalidError extends ModalError {}

/**
 * Queue is empty
 */
export class QueueEmptyError extends ModalError {}

/**
 * Queue is full
 */
export class QueueFullError extends ModalError {}

/**
 * Invalid Sandbox filesystem operation
 */
export class SandboxFilesystemError extends ModalError {}

/**
 * Sandbox filesystem path was not found
 */
export class SandboxFilesystemNotFoundError extends SandboxFilesystemError {}

/**
 * Sandbox filesystem directory is not empty
 */
export class SandboxFilesystemDirectoryNotEmptyError extends SandboxFilesystemError {}

/**
 * Sandbox filesystem target is a directory
 */
export class SandboxFilesystemIsADirectoryError extends SandboxFilesystemError {}

/**
 * Sandbox filesystem target is not a directory
 */
export class SandboxFilesystemNotADirectoryError extends SandboxFilesystemError {}

/**
 * Sandbox filesystem operation is not permitted
 */
export class SandboxFilesystemPermissionError extends SandboxFilesystemError {}

/**
 * Sandbox filesystem file is too large
 */
export class SandboxFilesystemFileTooLargeError extends SandboxFilesystemError {}

/**
 * Sandbox filesystem path already exists
 */
export class SandboxFilesystemPathAlreadyExistsError extends SandboxFilesystemError {}

/**
 * Sandbox operation exceeded the allowed time
 */
export class SandboxTimeoutError extends ModalError {
	constructor(message = "Sandbox operation timed out") {
		super(message);
	}
}

/**
 * An operation was attempted on a detached sandbox
 */
export class ClientClosedError extends ModalError {
	constructor(message = "Unable to perform operation on a detached sandbox") {
		super(message);
	}
}
