import { getDefaultClient, type ModalClient } from "@/core/client";
import { aliasedBoolean } from "@/utils/param_aliases";
import { checkForRenamedParams } from "@/utils/validation";
import { ControlPlaneInvocation } from "./invocation";

/**
 * @description Service for managing {@link FunctionCall}
 *
 * Usually accessed only through the client:
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
	 * @description Gets a FunctionCall by ID
	 * @param functionCallId - FunctionCall ID
	 * @returns FunctionCall instance
	 */
	async fromId(functionCallId: string): Promise<FunctionCall> {
		return new FunctionCall(this.#client, functionCallId);
	}

	/**
	 * @description Python-compatible alias for {@link FunctionCallService#fromId}
	 */
	async from_id(functionCallId: string): Promise<FunctionCall> {
		return await this.fromId(functionCallId);
	}
}

/**
 * @description Optional parameters for FunctionCall.get()
 * @property timeoutMs - Timeout in milliseconds for waiting on the result @optional
 */
export type FunctionCallGetParams = {
	timeoutMs?: number;
	index?: number;
};

/**
 * @description Optional parameters for FunctionCall.cancel()
 * @property terminateContainers - Whether to terminate containers too @optional
 */
export type FunctionCallCancelParams = {
	terminateContainers?: boolean;
	terminate_containers?: boolean;
};

/**
 * @description Represents a Modal FunctionCall, a {@link Function_} invocation for a given input,
 * whose result can be retrieved asynchronously with {@link FunctionCall#get} or cancelled with {@link FunctionCall#cancel}
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
	 * @description Python-compatible static helper that creates a handle from a FunctionCall ID
	 */
	static from_id(functionCallId: string): FunctionCall {
		return new FunctionCall(getDefaultClient(), functionCallId);
	}

	static fromId(functionCallId: string): FunctionCall {
		return FunctionCall.from_id(functionCallId);
	}

	/**
	 * @description Gets the FunctionCall result, optionally waiting with a timeout
	 * @param params - Optional parameters
	 * @returns Function execution result
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
	 * @description Returns the number of inputs included in the FunctionCall
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
	 * @description Python-compatible alias for {@link FunctionCall#numInputs}
	 */
	async num_inputs(): Promise<number> {
		return await this.numInputs();
	}

	/**
	 * @description Returns the function call graph
	 */
	async getCallGraph(): Promise<unknown> {
		const cpClient = this.#client?.cpClient || getDefaultClient().cpClient;
		return await cpClient.functionGetCallGraph({
			functionCallId: this.functionCallId,
		});
	}

	/**
	 * @description Python-compatible alias for {@link FunctionCall#getCallGraph}
	 */
	async get_call_graph(): Promise<unknown> {
		return await this.getCallGraph();
	}

	/**
	 * @description Iterates results for multiple inputs in index order
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
	 * @description Waits for multiple FunctionCall results while preserving order
	 * @param functionCalls - Array of FunctionCalls
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
	 * @description Cancels a running FunctionCall
	 * @param params - Optional parameters
	 */
	async cancel(params: FunctionCallCancelParams = {}) {
		const cpClient = this.#client?.cpClient || getDefaultClient().cpClient;
		const terminateContainers = aliasedBoolean(
			params,
			"terminateContainers",
			"terminate_containers",
		);

		await cpClient.functionCallCancel({
			functionCallId: this.functionCallId,
			...(terminateContainers !== undefined && { terminateContainers }),
		});
	}
}
