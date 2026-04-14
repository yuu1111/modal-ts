import { ClientError, type ClientMiddleware, Status } from "nice-grpc";

/**
 * @description gRPC呼び出しのタイムアウト設定
 * @property timeoutMs - タイムアウト(ミリ秒) @optional
 */
export type TimeoutOptions = {
	timeoutMs?: number;
};

/**
 * @description gRPC呼び出しにタイムアウトを設定するミドルウェア
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
 * @description リトライ対象のgRPCステータスコード
 */
export const retryableGrpcStatusCodes = new Set([
	Status.DEADLINE_EXCEEDED,
	Status.UNAVAILABLE,
	Status.CANCELLED,
	Status.INTERNAL,
	Status.UNKNOWN,
]);

/**
 * @description エラーがリトライ可能なgRPCステータスコードかを判定する
 * @param err - 判定対象のエラー
 * @returns リトライ可能ならtrue
 */
export function isRetryableGrpc(err: unknown) {
	if (err instanceof ClientError) {
		return retryableGrpcStatusCodes.has(err.code);
	}
	return false;
}

/**
 * @description AbortSignalでキャンセル可能なスリープ
 * @param ms - 待機時間(ミリ秒)
 * @param signal - キャンセル用シグナル @optional
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
 * @description gRPCリトライの動作設定
 * @property retries - リトライ回数 @optional @defaultValue 3
 * @property baseDelay - 初回遅延(ミリ秒) @optional @defaultValue 100
 * @property maxDelay - 最大遅延(ミリ秒) @optional @defaultValue 1000
 * @property delayFactor - 指数バックオフの乗数 @optional @defaultValue 2
 * @property additionalStatusCodes - 追加でリトライするステータスコード @optional
 */
export type RetryOptions = {
	retries?: number;
	baseDelay?: number;
	maxDelay?: number;
	delayFactor?: number;
	additionalStatusCodes?: Status[];
};
