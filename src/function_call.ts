// Manage existing Function Calls (look-ups, polling for output, cancellation).

import { getDefaultClient, type ModalClient } from "./client";
import { ControlPlaneInvocation } from "./invocation";
import { checkForRenamedParams } from "./validation";

/**
 * Service for managing {@link FunctionCall}s.
 *
 * Normally only ever accessed via the client as:
 *
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
};

/**
 * @description FunctionCall.cancel()のオプションパラメータ
 * @property terminateContainers - コンテナも終了するか @optional
 */
export type FunctionCallCancelParams = {
	terminateContainers?: boolean;
};

/**
 * Represents a Modal FunctionCall. FunctionCalls are {@link Function_ Function} invocations with
 * a given input. They can be consumed asynchronously (see {@link FunctionCall#get FunctionCall.get()}) or cancelled
 * (see {@link FunctionCall#cancel FunctionCall.cancel()}).
 */
export class FunctionCall {
	readonly functionCallId: string;
	#client?: ModalClient;

	/** @internal */
	constructor(client: ModalClient | undefined, functionCallId: string) {
		if (client !== undefined) this.#client = client;
		this.functionCallId = functionCallId;
	}

	/**
	 * @deprecated Use {@link FunctionCallService#fromId client.functionCalls.fromId()} instead.
	 */
	static fromId(functionCallId: string): FunctionCall {
		return new FunctionCall(undefined, functionCallId);
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
		return invocation.awaitOutput(params.timeoutMs);
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
