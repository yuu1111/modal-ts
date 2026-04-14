import { ClientError, Status } from "nice-grpc";
import { AlreadyExistsError, InvalidError, NotFoundError } from "@/core/errors";

/**
 * @description rethrow 関数群の共通オプション
 * @property message - エラーメッセージ。省略時は err.details || err.message を使用
 * @property preconditionPatterns - FAILED_PRECONDITION も変換する条件。空配列なら無条件、文字列配列なら details にパターンが含まれる場合のみ
 */
export interface RethrowOptions {
	message?: string;
	preconditionPatterns?: string[];
}

/**
 * @description gRPC ステータスコードをドメインエラーに変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param ErrorClass - スローするエラークラス
 * @param primaryStatus - 主に判定する gRPC ステータスコード
 * @param options - メッセージと precondition 設定
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
 * @description 文字列またはオプションオブジェクトを RethrowOptions に正規化する
 * @param messageOrOptions - メッセージ文字列、またはオプションオブジェクト
 */
function resolveOptions(
	messageOrOptions: string | RethrowOptions | undefined,
): RethrowOptions {
	if (typeof messageOrOptions === "string")
		return { message: messageOrOptions };
	return messageOrOptions ?? {};
}

/**
 * @description gRPC の NOT_FOUND を NotFoundError に変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param messageOrOptions - メッセージ文字列、またはオプションオブジェクト
 */
export function rethrowNotFound(
	err: unknown,
	messageOrOptions?: string | RethrowOptions,
): never {
	rethrowGrpc(err, NotFoundError, Status.NOT_FOUND, resolveOptions(messageOrOptions));
}

/**
 * @description gRPC の INVALID_ARGUMENT を InvalidError に変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param messageOrOptions - メッセージ文字列、またはオプションオブジェクト
 */
export function rethrowInvalid(
	err: unknown,
	messageOrOptions?: string | RethrowOptions,
): never {
	rethrowGrpc(err, InvalidError, Status.INVALID_ARGUMENT, resolveOptions(messageOrOptions));
}

/**
 * @description gRPC の ALREADY_EXISTS を AlreadyExistsError に変換して再スローする。
 * 該当しなければ元のエラーをそのまま再スローする
 * @param err - catch されたエラー
 * @param messageOrOptions - メッセージ文字列、またはオプションオブジェクト
 */
export function rethrowAlreadyExists(
	err: unknown,
	messageOrOptions?: string | RethrowOptions,
): never {
	rethrowGrpc(err, AlreadyExistsError, Status.ALREADY_EXISTS, resolveOptions(messageOrOptions));
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
