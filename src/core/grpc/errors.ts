import { ClientError, Status } from "nice-grpc";
import { AlreadyExistsError, InvalidError, NotFoundError } from "@/core/errors";

/**
 * @description gRPC ステータスコードをドメインエラーに変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param ErrorClass - スローするエラークラス
 * @param primaryStatus - 主に判定する gRPC ステータスコード
 * @param message - エラーメッセージ。省略時は err.details || err.message を使用
 * @param precondition - FAILED_PRECONDITION も変換する条件。空配列なら無条件、文字列配列なら details にパターンが含まれる場合のみ
 */
function rethrowGrpc(
	err: unknown,
	ErrorClass: new (message: string) => Error,
	primaryStatus: Status,
	message: string | undefined,
	precondition: string[] | undefined,
): never {
	if (err instanceof ClientError) {
		const msg = message ?? (err.details || err.message);
		if (err.code === primaryStatus) throw new ErrorClass(msg);
		if (
			err.code === Status.FAILED_PRECONDITION &&
			precondition &&
			(precondition.length === 0 ||
				precondition.some((p) => err.details.includes(p)))
		)
			throw new ErrorClass(msg);
	}
	throw err;
}

/**
 * @description gRPC の NOT_FOUND を NotFoundError に変換して再スローする。
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
	rethrowGrpc(
		err,
		NotFoundError,
		Status.NOT_FOUND,
		message,
		alsoNotFoundPatterns.length > 0 ? alsoNotFoundPatterns : undefined,
	);
}

/**
 * @description gRPC の INVALID_ARGUMENT を InvalidError に変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param includePrecondition - true なら FAILED_PRECONDITION も InvalidError として扱う
 */
export function rethrowInvalid(
	err: unknown,
	includePrecondition = false,
): never {
	rethrowGrpc(
		err,
		InvalidError,
		Status.INVALID_ARGUMENT,
		undefined,
		includePrecondition ? [] : undefined,
	);
}

/**
 * @description gRPC の ALREADY_EXISTS を AlreadyExistsError に変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param message - AlreadyExistsError に使うメッセージ。省略時は err.details を使用
 */
export function rethrowAlreadyExists(err: unknown, message?: string): never {
	rethrowGrpc(
		err,
		AlreadyExistsError,
		Status.ALREADY_EXISTS,
		message,
		undefined,
	);
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
