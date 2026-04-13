import type { ModalClient, ModalGrpcClient } from "@/core/client";
import {
	FunctionTimeoutError,
	InternalFailure,
	RemoteError,
} from "@/core/errors";
import {
	DataFormat,
	type FunctionCallInvocationType,
	FunctionCallType,
	type FunctionGetOutputsItem,
	type FunctionInput,
	FunctionPutInputsItem,
	type FunctionRetryInputsItem,
	GeneratorDone,
	type GenericResult,
	GenericResult_GenericStatus,
} from "@/generated/modal_proto/api";
import { cborDecode } from "@/utils/serialization";

// Python SDK の modal/_utils/function_utils.py に由来
const outputsTimeoutMs = 55 * 1000;

/**
 * @description コントロールプレーンまたはインプットプレーンへの入力送信を抽象化する。
 * コントロールプレーン: FunctionMap, FunctionRetryInputs, FunctionGetOutputs RPC を使用。
 * インプットプレーン: AttemptStart, AttemptRetry, AttemptAwait RPC を使用
 */
export interface Invocation {
	awaitOutput(timeoutMs?: number): Promise<unknown>;
	retry(retryCount: number): Promise<void>;
}

/**
 * @description コントロールプレーン経由の Invocation 実装
 */
export class ControlPlaneInvocation implements Invocation {
	private readonly cpClient: ModalGrpcClient;
	readonly functionCallId: string;
	private readonly input?: FunctionInput;
	private readonly functionCallJwt?: string;
	private inputJwt?: string;

	private constructor(
		cpClient: ModalGrpcClient,
		functionCallId: string,
		input?: FunctionInput,
		functionCallJwt?: string,
		inputJwt?: string,
	) {
		this.cpClient = cpClient;
		this.functionCallId = functionCallId;
		if (input !== undefined) this.input = input;
		if (functionCallJwt !== undefined) this.functionCallJwt = functionCallJwt;
		if (inputJwt !== undefined) this.inputJwt = inputJwt;
	}

	static async create(
		client: ModalClient,
		functionId: string,
		input: FunctionInput,
		invocationType: FunctionCallInvocationType,
	) {
		const functionPutInputsItem = FunctionPutInputsItem.create({
			idx: 0,
			input,
		});

		const functionMapResponse = await client.cpClient.functionMap({
			functionId,
			functionCallType: FunctionCallType.FUNCTION_CALL_TYPE_UNARY,
			functionCallInvocationType: invocationType,
			pipelinedInputs: [functionPutInputsItem],
		});

		return new ControlPlaneInvocation(
			client.cpClient,
			functionMapResponse.functionCallId,
			input,
			functionMapResponse.functionCallJwt,
			functionMapResponse.pipelinedInputs[0]?.inputJwt,
		);
	}

	static fromFunctionCallId(client: ModalClient, functionCallId: string) {
		return new ControlPlaneInvocation(client.cpClient, functionCallId);
	}

	async awaitOutput(timeoutMs?: number): Promise<unknown> {
		return await pollFunctionOutput(
			this.cpClient,
			(timeoutMs: number) => this.#getOutput(timeoutMs),
			timeoutMs,
		);
	}

	async #getOutput(
		timeoutMs: number,
	): Promise<FunctionGetOutputsItem | undefined> {
		const response = await this.cpClient.functionGetOutputs({
			functionCallId: this.functionCallId,
			maxValues: 1,
			timeout: timeoutMs / 1000,
			lastEntryId: "0-0",
			clearOnSuccess: true,
			requestedAt: timeNowSeconds(),
		});
		return response.outputs ? response.outputs[0] : undefined;
	}

	async retry(retryCount: number): Promise<void> {
		// 通常到達しないパス
		if (!this.input) {
			throw new Error("Cannot retry Function invocation - input missing");
		}

		if (!this.inputJwt) {
			throw new Error("Cannot retry Function invocation - inputJwt missing");
		}

		const retryItem: FunctionRetryInputsItem = {
			inputJwt: this.inputJwt,
			input: this.input,
			retryCount,
		};

		const functionRetryResponse = await this.cpClient.functionRetryInputs({
			...(this.functionCallJwt !== undefined && {
				functionCallJwt: this.functionCallJwt,
			}),
			inputs: [retryItem],
		});
		const newInputJwt = functionRetryResponse.inputJwts[0];
		if (!newInputJwt) {
			throw new Error(
				"Server returned empty inputJwt from functionRetryInputs",
			);
		}
		this.inputJwt = newInputJwt;
	}
}

/**
 * @description インプットプレーン経由の Invocation 実装
 */
export class InputPlaneInvocation implements Invocation {
	private readonly cpClient: ModalGrpcClient;
	private readonly ipClient: ModalGrpcClient;
	private readonly functionId: string;
	private readonly input: FunctionPutInputsItem;
	private attemptToken: string;

	constructor(
		cpClient: ModalGrpcClient,
		ipClient: ModalGrpcClient,
		functionId: string,
		input: FunctionPutInputsItem,
		attemptToken: string,
	) {
		this.cpClient = cpClient;
		this.ipClient = ipClient;
		this.functionId = functionId;
		this.input = input;
		this.attemptToken = attemptToken;
	}

	static async create(
		client: ModalClient,
		inputPlaneUrl: string,
		functionId: string,
		input: FunctionInput,
	) {
		const functionPutInputsItem = FunctionPutInputsItem.create({
			idx: 0,
			input,
		});
		const ipClient = client.ipClient(inputPlaneUrl);
		// 単一入力の同期呼び出し
		const attemptStartResponse = await ipClient.attemptStart({
			functionId,
			input: functionPutInputsItem,
		});
		return new InputPlaneInvocation(
			client.cpClient,
			ipClient,
			functionId,
			functionPutInputsItem,
			attemptStartResponse.attemptToken,
		);
	}

	async awaitOutput(timeoutMs?: number): Promise<unknown> {
		return await pollFunctionOutput(
			this.cpClient,
			(timeoutMs: number) => this.#getOutput(timeoutMs),
			timeoutMs,
		);
	}

	async #getOutput(
		timeoutMs: number,
	): Promise<FunctionGetOutputsItem | undefined> {
		const response = await this.ipClient.attemptAwait({
			attemptToken: this.attemptToken,
			requestedAt: timeNowSeconds(),
			timeoutSecs: timeoutMs / 1000,
		});
		return response.output;
	}

	async retry(_retryCount: number): Promise<void> {
		const attemptRetryResponse = await this.ipClient.attemptRetry({
			functionId: this.functionId,
			input: this.input,
			attemptToken: this.attemptToken,
		});
		this.attemptToken = attemptRetryResponse.attemptToken;
	}
}

function timeNowSeconds() {
	return Date.now() / 1e3;
}

/**
 * @description 指定タイムアウトで出力を1件取得する関数のシグネチャ。
 * `pollFunctionOutput` がコントロールプレーンまたはインプットプレーンから取得する際に使用
 */
type GetOutput = (
	timeoutMs: number,
) => Promise<FunctionGetOutputsItem | undefined>;

/**
 * @description `getOutput` で出力をポーリングする。
 * タイムアウト未指定または55秒超の場合は55秒で区切って繰り返す
 */
async function pollFunctionOutput(
	cpClient: ModalGrpcClient,
	getOutput: GetOutput,
	timeoutMs?: number,
): Promise<unknown> {
	const startTime = Date.now();
	let pollTimeoutMs = outputsTimeoutMs;
	if (timeoutMs !== undefined) {
		pollTimeoutMs = Math.min(timeoutMs, outputsTimeoutMs);
	}

	while (true) {
		const output = await getOutput(pollTimeoutMs);
		if (output) {
			return await processResult(cpClient, output.result, output.dataFormat);
		}

		if (timeoutMs !== undefined) {
			const remainingMs = timeoutMs - (Date.now() - startTime);
			if (remainingMs <= 0) {
				const message = `Timeout exceeded: ${timeoutMs}ms`;
				throw new FunctionTimeoutError(message);
			}
			pollTimeoutMs = Math.min(outputsTimeoutMs, remainingMs);
		}
	}
}

async function processResult(
	cpClient: ModalGrpcClient,
	result: GenericResult | undefined,
	dataFormat: DataFormat,
): Promise<unknown> {
	if (!result) {
		throw new Error("Received null result from invocation");
	}

	let data = new Uint8Array();
	if (result.data !== undefined) {
		data = result.data as Uint8Array<ArrayBuffer>;
	} else if (result.dataBlobId) {
		data = (await blobDownload(
			cpClient,
			result.dataBlobId,
		)) as Uint8Array<ArrayBuffer>;
	}

	switch (result.status) {
		case GenericResult_GenericStatus.GENERIC_STATUS_TIMEOUT:
			throw new FunctionTimeoutError(`Timeout: ${result.exception}`);
		case GenericResult_GenericStatus.GENERIC_STATUS_INTERNAL_FAILURE:
			throw new InternalFailure(`Internal failure: ${result.exception}`);
		case GenericResult_GenericStatus.GENERIC_STATUS_SUCCESS:
			// データのデシリアライズに進む
			break;
		default:
			throw new RemoteError(`Remote error: ${result.exception}`);
	}

	return deserializeDataFormat(data, dataFormat);
}

async function blobDownload(
	cpClient: ModalGrpcClient,
	blobId: string,
): Promise<Uint8Array> {
	const resp = await cpClient.blobGet({ blobId });
	const s3resp = await fetch(resp.downloadUrl);
	if (!s3resp.ok) {
		throw new Error(`Failed to download blob: ${s3resp.statusText}`);
	}
	const buf = await s3resp.arrayBuffer();
	return new Uint8Array(buf);
}

function deserializeDataFormat(
	data: Uint8Array | undefined,
	dataFormat: DataFormat,
): unknown {
	if (!data) {
		return null;
	}

	switch (dataFormat) {
		case DataFormat.DATA_FORMAT_PICKLE:
			throw new Error(
				"PICKLE output format is not supported - remote function must return CBOR format",
			);
		case DataFormat.DATA_FORMAT_CBOR:
			return cborDecode(data);
		case DataFormat.DATA_FORMAT_ASGI:
			throw new Error("ASGI data format is not supported in modal-js");
		case DataFormat.DATA_FORMAT_GENERATOR_DONE:
			return GeneratorDone.decode(data);
		default:
			throw new Error(`Unsupported data format: ${dataFormat}`);
	}
}
