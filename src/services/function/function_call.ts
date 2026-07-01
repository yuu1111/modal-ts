import { getDefaultClient, type ModalClient } from "@/core/client";
import { checkForRenamedParams } from "@/utils/validation";
import { ControlPlaneInvocation } from "./invocation";

/**
 * @description {@link FunctionCall} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const functionCall = await modal.functionCalls.fromId("123");
 * ```
 */
export class FunctionCallService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description IDからFunctionCallを取得する
	 * @param functionCallId - FunctionCall ID
	 * @returns FunctionCallインスタンス
	 */
	async fromId(functionCallId: string): Promise<FunctionCall> {
		return new FunctionCall(this.#client, functionCallId);
	}
}

/**
 * @description FunctionCall.get()のオプションパラメータ
 * @property timeoutMs - 結果待ちのタイムアウト(ミリ秒) @optional
 */
export type FunctionCallGetParams = {
	timeoutMs?: number;
	index?: number;
};

/**
 * @description FunctionCall.cancel()のオプションパラメータ
 * @property terminateContainers - コンテナも終了するか @optional
 */
export type FunctionCallCancelParams = {
	terminateContainers?: boolean;
};

/**
 * @description Modal FunctionCall を表す。指定された入力での {@link Function_} 呼び出しであり、
 * 非同期に結果を取得({@link FunctionCall#get})またはキャンセル({@link FunctionCall#cancel})できる
 */
export class FunctionCall {
	readonly functionCallId: string;
	#client?: ModalClient;
	#numInputs?: number;

	/**
	 * @internal
	 */
	constructor(client: ModalClient | undefined, functionCallId: string) {
		if (client !== undefined) this.#client = client;
		this.functionCallId = functionCallId;
	}

	/**
	 * @description FunctionCallの結果を取得する(タイムアウト付き待機可)
	 * @param params - オプションパラメータ
	 * @returns Function実行結果
	 */
	async get(params: FunctionCallGetParams = {}): Promise<unknown> {
		checkForRenamedParams(params, { timeout: "timeoutMs" });

		const invocation = ControlPlaneInvocation.fromFunctionCallId(
			this.#client || getDefaultClient(),
			this.functionCallId,
		);
		return invocation.awaitOutput(params.timeoutMs, params.index ?? 0);
	}

	/**
	 * @description FunctionCall に含まれる input 数を返す
	 */
	async numInputs(): Promise<number> {
		if (this.#numInputs !== undefined) return this.#numInputs;
		const cpClient = this.#client?.cpClient || getDefaultClient().cpClient;
		const resp = await cpClient.functionCallFromId({
			functionCallId: this.functionCallId,
		});
		this.#numInputs = resp.numInputs;
		return this.#numInputs;
	}

	/**
	 * @description 複数 input の結果を index 順に iterate する
	 * @param params - start/end index
	 */
	async *iter(
		params: { start?: number; end?: number; timeoutMs?: number } = {},
	): AsyncGenerator<unknown, void, unknown> {
		const numInputs = await this.numInputs();
		const start = params.start ?? 0;
		const end = params.end ?? numInputs;
		if (start < 0 || end > numInputs || start > end) {
			throw new RangeError(
				`Invalid index range: ${start} to ${end} for ${numInputs} inputs`,
			);
		}
		for (let index = start; index < end; index++) {
			yield await this.get({
				index,
				...(params.timeoutMs !== undefined && {
					timeoutMs: params.timeoutMs,
				}),
			});
		}
	}

	/**
	 * @description 複数の FunctionCall の結果を順序を保って待つ
	 * @param functionCalls - FunctionCall の配列
	 */
	static async gather(...functionCalls: FunctionCall[]): Promise<unknown[]>;
	static async gather(functionCalls: FunctionCall[]): Promise<unknown[]>;
	static async gather(
		...functionCalls: FunctionCall[] | [FunctionCall[]]
	): Promise<unknown[]> {
		const calls = Array.isArray(functionCalls[0])
			? functionCalls[0]
			: (functionCalls as FunctionCall[]);
		return await Promise.all(calls.map((fc) => fc.get()));
	}

	/**
	 * @description 実行中のFunctionCallをキャンセルする
	 * @param params - オプションパラメータ
	 */
	async cancel(params: FunctionCallCancelParams = {}) {
		const cpClient = this.#client?.cpClient || getDefaultClient().cpClient;

		await cpClient.functionCallCancel({
			functionCallId: this.functionCallId,
			...(params.terminateContainers !== undefined && {
				terminateContainers: params.terminateContainers,
			}),
		});
	}
}
