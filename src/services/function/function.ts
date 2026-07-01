import { createHash } from "node:crypto";
import type { ModalClient, ModalGrpcClient } from "@/core/client";
import { InternalFailure, InvalidError } from "@/core/errors";
import { rethrowNotFound } from "@/core/grpc/errors";
import {
	ClassParameterSet,
	type ClassParameterSpec,
	type ClassParameterValue,
	DataFormat,
	FunctionCallInvocationType,
	type FunctionHandleMetadata,
	type FunctionInput,
	FunctionOptions as FunctionOptionsProto,
	type FunctionRetryPolicy,
	ParameterType,
	type VolumeMount,
} from "@/generated/modal_proto/api";
import { parseGpuConfig } from "@/services/deploy/app";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import { mergeEnvIntoSecrets, type Secret } from "@/services/secret/secret";
import { type Volume, volumeToMountProto } from "@/services/volume/volume";
import { parseRetries, type Retries } from "@/utils/retries";
import { cborEncode } from "@/utils/serialization";
import { checkForRenamedParams } from "@/utils/validation";
import { FunctionCall } from "./function_call";
import {
	ControlPlaneInvocation,
	InputPlaneInvocation,
	type Invocation,
} from "./invocation";

/**
 * @description Blobアップロードの閾値
 */
const maxObjectSizeBytes = 2 * 1024 * 1024; // 2 MiB

/**
 * @description InternalFailure時の最大リトライ回数
 */
const maxSystemRetries = 8;

/**
 * @description `client.functions.fromName()` のオプションパラメータ
 * @property environment - 環境名 @optional
 * @property createIfMissing - 存在しない場合に作成するか @optional
 */
export type FunctionFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * @description {@link Function_} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const fn = await modal.functions.fromName("my-app", "my-function");
 * ```
 */
export class FunctionService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description App内のFunctionを名前で取得する
	 * @param appName - アプリ名
	 * @param name - Function名
	 * @param params - オプションパラメータ
	 * @returns Functionインスタンス
	 * @throws NotFoundError 指定されたFunctionが存在しない場合
	 */
	async fromName(
		appName: string,
		name: string,
		params: FunctionFromNameParams = {},
	): Promise<Function_> {
		if (name.includes(".")) {
			const [clsName, methodName] = name.split(".", 2);
			throw new Error(
				`Cannot retrieve Cls methods using 'functions.fromName()'. Use:\n  const cls = await client.cls.fromName("${appName}", "${clsName}");\n  const instance = await cls.instance();\n  const m = instance.method("${methodName}");`,
			);
		}
		try {
			const resp = await this.#client.cpClient.functionGet({
				appName,
				objectTag: name,
				environmentName: this.#client.environmentName(params.environment),
			});
			this.#client.logger.debug(
				"Retrieved Function",
				"function_id",
				resp.functionId,
				"app_name",
				appName,
				"function_name",
				name,
			);
			return new Function_(
				this.#client,
				resp.functionId,
				undefined,
				resp.handleMetadata,
			);
		} catch (err) {
			rethrowNotFound(err, `Function '${appName}/${name}' not found`);
		}
	}
}

/**
 * @description 実行中のFunctionの統計情報
 * @property backlog - 未処理の入力数
 * @property numTotalRunners - 総ランナー数
 */
export interface FunctionStats {
	backlog: number;
	numTotalRunners: number;
}

/**
 * @description オートスケーラーの更新パラメータ
 * @property minContainers - 最小コンテナ数 @optional
 * @property maxContainers - 最大コンテナ数 @optional
 * @property bufferContainers - バッファコンテナ数 @optional
 * @property targetConcurrency - 目標同時リクエスト数 @optional
 * @property scaleupWindowMs - スケールアップ猶予期間(ミリ秒) @optional
 * @property scaledownWindowMs - スケールダウン猶予期間(ミリ秒) @optional
 */
export interface FunctionUpdateAutoscalerParams {
	minContainers?: number;
	maxContainers?: number;
	bufferContainers?: number;
	targetConcurrency?: number;
	scaleupWindowMs?: number;
	scaledownWindowMs?: number;
}

/**
 * @description Function のランタイムオプション上書きパラメータ
 * @property cpu - CPU コア数 @optional
 * @property cpuLimit - CPU コア数の上限 @optional
 * @property memoryMiB - メモリ(MiB) @optional
 * @property memoryLimitMiB - メモリ上限(MiB) @optional
 * @property gpu - GPU 設定文字列 @optional
 * @property env - 環境変数 @optional
 * @property secrets - シークレット @optional
 * @property volumes - ボリュームマウント @optional
 * @property retries - リトライポリシー @optional
 * @property maxContainers - 最大コンテナ数 @optional
 * @property bufferContainers - バッファコンテナ数 @optional
 * @property scaledownWindowMs - スケールダウン待機時間(ミリ秒) @optional
 * @property timeoutMs - タイムアウト(ミリ秒) @optional
 * @property schedulerPlacement - スケジューリング制約 @optional
 */
export type FunctionWithOptionsParams = {
	cpu?: number;
	cpuLimit?: number;
	memoryMiB?: number;
	memoryLimitMiB?: number;
	gpu?: string;
	env?: Record<string, string>;
	secrets?: Secret[];
	volumes?: Record<string, Volume>;
	retries?: number | Retries;
	maxContainers?: number;
	bufferContainers?: number;
	scaledownWindowMs?: number;
	timeoutMs?: number;
	schedulerPlacement?: SchedulerPlacement;
};

/**
 * @description Function の同時実行設定パラメータ
 * @property maxInputs - 最大同時入力数
 * @property targetInputs - 目標同時入力数 @optional
 */
export type FunctionWithConcurrencyParams = {
	maxInputs: number;
	targetInputs?: number;
};

/**
 * @description Function のダイナミックバッチング設定パラメータ
 * @property maxBatchSize - 最大バッチサイズ
 * @property waitMs - バッチ待機時間(ミリ秒)
 */
export type FunctionWithBatchingParams = {
	maxBatchSize: number;
	waitMs: number;
};

/**
 * @description Function の内部オプション(公開パラメータ + 内部フィールド)
 */
export type FunctionOptions = FunctionWithOptionsParams & {
	maxConcurrentInputs?: number;
	targetConcurrentInputs?: number;
	batchMaxSize?: number;
	batchWaitMs?: number;
};

/**
 * @description ベースオプションに差分をマージする
 * @param base - ベースオプション
 * @param diff - マージする差分
 * @returns マージ結果(空の場合は undefined)
 * @internal
 */
export function mergeServiceOptions(
	base: FunctionOptions | undefined,
	diff: Partial<FunctionOptions>,
): FunctionOptions | undefined {
	const filteredDiff = Object.fromEntries(
		Object.entries(diff).filter(([, value]) => value !== undefined),
	) as Partial<FunctionOptions>;
	const merged = { ...(base ?? {}), ...filteredDiff } as FunctionOptions;
	return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * @description FunctionOptions から gRPC FunctionOptions プロトコルバッファを構築する
 * @param options - Function オプション
 * @returns FunctionOptions プロトメッセージ(オプションが空の場合は undefined)
 * @internal
 */
export async function buildFunctionOptionsProto(
	options?: FunctionOptions,
): Promise<FunctionOptionsProto | undefined> {
	if (!options) return undefined;
	const o = options;

	checkForRenamedParams(o, {
		memory: "memoryMiB",
		memoryLimit: "memoryLimitMiB",
		scaledownWindow: "scaledownWindowMs",
		timeout: "timeoutMs",
	});

	const gpuConfig = parseGpuConfig(o.gpu);

	let milliCpu: number | undefined;
	let milliCpuMax: number | undefined;
	if (o.cpu === undefined && o.cpuLimit !== undefined) {
		throw new Error("must also specify cpu when cpuLimit is specified");
	}
	if (o.cpu !== undefined) {
		if (o.cpu <= 0) {
			throw new Error(`cpu (${o.cpu}) must be a positive number`);
		}
		milliCpu = Math.trunc(1000 * o.cpu);
		if (o.cpuLimit !== undefined) {
			if (o.cpuLimit < o.cpu) {
				throw new Error(
					`cpu (${o.cpu}) cannot be higher than cpuLimit (${o.cpuLimit})`,
				);
			}
			milliCpuMax = Math.trunc(1000 * o.cpuLimit);
		}
	}

	let memoryMb: number | undefined;
	let memoryMbMax: number | undefined;
	if (o.memoryMiB === undefined && o.memoryLimitMiB !== undefined) {
		throw new Error(
			"must also specify memoryMiB when memoryLimitMiB is specified",
		);
	}
	if (o.memoryMiB !== undefined) {
		if (o.memoryMiB <= 0) {
			throw new Error(`memoryMiB (${o.memoryMiB}) must be a positive number`);
		}
		memoryMb = o.memoryMiB;
		if (o.memoryLimitMiB !== undefined) {
			if (o.memoryLimitMiB < o.memoryMiB) {
				throw new Error(
					`memoryMiB (${o.memoryMiB}) cannot be higher than memoryLimitMiB (${o.memoryLimitMiB})`,
				);
			}
			memoryMbMax = o.memoryLimitMiB;
		}
	}

	const resources =
		milliCpu !== undefined ||
		milliCpuMax !== undefined ||
		memoryMb !== undefined ||
		memoryMbMax !== undefined ||
		gpuConfig
			? {
					...(milliCpu !== undefined && { milliCpu }),
					...(milliCpuMax !== undefined && { milliCpuMax }),
					...(memoryMb !== undefined && { memoryMb }),
					...(memoryMbMax !== undefined && { memoryMbMax }),
					gpuConfig,
				}
			: undefined;

	const secretIds = (o.secrets || []).map((s) => s.secretId);
	const volumeMounts: VolumeMount[] = o.volumes
		? Object.entries(o.volumes).map(([mountPath, volume]) =>
				volumeToMountProto(mountPath, volume),
			)
		: [];

	const parsedRetries = parseRetries(o.retries);
	const retryPolicy: FunctionRetryPolicy | undefined = parsedRetries
		? {
				retries: parsedRetries.maxRetries,
				backoffCoefficient: parsedRetries.backoffCoefficient,
				initialDelayMs: parsedRetries.initialDelayMs,
				maxDelayMs: parsedRetries.maxDelayMs,
			}
		: undefined;

	if (o.scaledownWindowMs !== undefined && o.scaledownWindowMs % 1000 !== 0) {
		throw new Error(
			`scaledownWindowMs must be a multiple of 1000ms, got ${o.scaledownWindowMs}`,
		);
	}
	if (o.timeoutMs !== undefined && o.timeoutMs % 1000 !== 0) {
		throw new Error(
			`timeoutMs must be a multiple of 1000ms, got ${o.timeoutMs}`,
		);
	}

	return FunctionOptionsProto.create({
		secretIds,
		replaceSecretIds: secretIds.length > 0,
		replaceVolumeMounts: volumeMounts.length > 0,
		volumeMounts,
		resources,
		retryPolicy,
		concurrencyLimit: o.maxContainers,
		bufferContainers: o.bufferContainers,
		taskIdleTimeoutSecs:
			o.scaledownWindowMs !== undefined
				? o.scaledownWindowMs / 1000
				: undefined,
		timeoutSecs: o.timeoutMs !== undefined ? o.timeoutMs / 1000 : undefined,
		maxConcurrentInputs: o.maxConcurrentInputs,
		targetConcurrentInputs: o.targetConcurrentInputs,
		batchMaxSize: o.batchMaxSize,
		batchLingerMs: o.batchWaitMs,
		schedulerPlacement: o.schedulerPlacement?.toProto(),
	});
}

/**
 * @description パラメータスキーマに基づいてパラメータセットをエンコードする
 * @param schema - パラメータスキーマ
 * @param params - エンコードするパラメータ
 * @returns シリアライズされたバイト列
 * @internal
 */
export function encodeParameterSet(
	schema: ClassParameterSpec[],
	params: Record<string, unknown>,
): Uint8Array {
	const encoded: ClassParameterValue[] = [];
	for (const paramSpec of schema) {
		const paramValue = encodeParameter(paramSpec, params[paramSpec.name]);
		encoded.push(paramValue);
	}
	encoded.sort((a, b) => a.name.localeCompare(b.name));
	return ClassParameterSet.encode({ parameters: encoded }).finish();
}

function encodeParameter(
	paramSpec: ClassParameterSpec,
	value: unknown,
): ClassParameterValue {
	const name = paramSpec.name;
	const paramType = paramSpec.type;
	const paramValue: ClassParameterValue = { name, type: paramType };

	switch (paramType) {
		case ParameterType.PARAM_TYPE_STRING:
			if (value == null && paramSpec.hasDefault) {
				value = paramSpec.stringDefault ?? "";
			}
			if (typeof value !== "string") {
				throw new Error(`Parameter '${name}' must be a string`);
			}
			paramValue.stringValue = value;
			break;
		case ParameterType.PARAM_TYPE_INT:
			if (value == null && paramSpec.hasDefault) {
				value = paramSpec.intDefault ?? 0;
			}
			if (typeof value !== "number") {
				throw new Error(`Parameter '${name}' must be an integer`);
			}
			paramValue.intValue = value;
			break;
		case ParameterType.PARAM_TYPE_BOOL:
			if (value == null && paramSpec.hasDefault) {
				value = paramSpec.boolDefault ?? false;
			}
			if (typeof value !== "boolean") {
				throw new Error(`Parameter '${name}' must be a boolean`);
			}
			paramValue.boolValue = value;
			break;
		case ParameterType.PARAM_TYPE_BYTES:
			if (value == null && paramSpec.hasDefault) {
				value = paramSpec.bytesDefault ?? new Uint8Array();
			}
			if (!(value instanceof Uint8Array)) {
				throw new Error(`Parameter '${name}' must be a byte array`);
			}
			paramValue.bytesValue = value;
			break;
		default:
			throw new Error(`Unsupported parameter type: ${paramType}`);
	}

	return paramValue;
}

/**
 * @description Function にパラメータとランタイムオプションをバインドする
 * @param client - Modal クライアント
 * @param functionId - Function ID
 * @param options - ランタイムオプション
 * @param schema - パラメータスキーマ
 * @param parameters - バインドするパラメータ
 * @returns バインド結果
 * @internal
 */
export async function bindParameters(
	client: ModalClient,
	functionId: string,
	options: FunctionOptions = {},
	schema: ClassParameterSpec[] = [],
	parameters: Record<string, unknown> = {},
) {
	const mergedSecrets = await mergeEnvIntoSecrets(
		client,
		options.env,
		options.secrets,
	);
	const mergedOptions = mergeServiceOptions(options, {
		secrets: mergedSecrets,
	});

	const serializedParams = encodeParameterSet(schema, parameters);
	const functionOptions = await buildFunctionOptionsProto(mergedOptions);
	return await client.cpClient.functionBindParams({
		functionId,
		serializedParams,
		functionOptions,
		environmentName: client.environmentName(),
	});
}

/**
 * @description デプロイ済みModal Functionを表し、リモート実行が可能
 */
export class Function_ {
	readonly functionId: string;
	readonly methodName?: string;
	#client: ModalClient;
	#handleMetadata?: FunctionHandleMetadata;
	#options?: FunctionOptions;

	/**
	 * @internal
	 */
	constructor(
		client: ModalClient,
		functionId: string,
		methodName?: string,
		functionHandleMetadata?: FunctionHandleMetadata,
		options?: FunctionOptions,
	) {
		this.functionId = functionId;
		if (methodName !== undefined) this.methodName = methodName;

		this.#client = client;
		if (functionHandleMetadata !== undefined)
			this.#handleMetadata = functionHandleMetadata;
		if (options !== undefined) this.#options = options;
	}

	#checkNoWebUrl(fnName: string): void {
		if (this.#handleMetadata?.webUrl) {
			throw new InvalidError(
				`A webhook Function cannot be invoked for remote execution with '.${fnName}'. Invoke this Function via its web url '${this.#handleMetadata.webUrl}' instead.`,
			);
		}
	}

	/**
	 * @description 静的な Function 設定をランタイムで上書きする
	 * @param options - 上書きオプション
	 * @returns 新しいオプションが適用された Function
	 */
	withOptions(options: FunctionWithOptionsParams): Function_ {
		return new Function_(
			this.#client,
			this.functionId,
			this.methodName,
			this.#handleMetadata,
			mergeServiceOptions(this.#options, options),
		);
	}

	/**
	 * @description 同時実行設定を有効化または上書きした Function を返す
	 * @param params - 同時実行パラメータ
	 * @returns 同時実行設定が適用された Function
	 */
	withConcurrency(params: FunctionWithConcurrencyParams): Function_ {
		return new Function_(
			this.#client,
			this.functionId,
			this.methodName,
			this.#handleMetadata,
			mergeServiceOptions(this.#options, {
				maxConcurrentInputs: params.maxInputs,
				...(params.targetInputs !== undefined && {
					targetConcurrentInputs: params.targetInputs,
				}),
			}),
		);
	}

	/**
	 * @description ダイナミックバッチングを有効化または上書きした Function を返す
	 * @param params - バッチングパラメータ
	 * @returns バッチング設定が適用された Function
	 */
	withBatching(params: FunctionWithBatchingParams): Function_ {
		return new Function_(
			this.#client,
			this.functionId,
			this.methodName,
			this.#handleMetadata,
			mergeServiceOptions(this.#options, {
				batchMaxSize: params.maxBatchSize,
				batchWaitMs: params.waitMs,
			}),
		);
	}

	/**
	 * @description withOptions/withConcurrency/withBatching の設定を適用した Function インスタンスを生成する
	 * @returns 設定がバインドされた Function
	 */
	async instance(): Promise<Function_> {
		let newFunctionId = this.functionId;
		if (this.#options !== undefined && Object.keys(this.#options).length > 0) {
			const boundFunction = await bindParameters(
				this.#client,
				this.functionId,
				this.#options,
			);
			newFunctionId = boundFunction.boundFunctionId;
		}

		return new Function_(
			this.#client,
			newFunctionId,
			this.methodName,
			this.#handleMetadata,
		);
	}

	/**
	 * @description Functionを同期的にリモート実行し、結果を返す
	 * @param args - 位置引数の配列
	 * @param kwargs - キーワード引数のマッピング
	 * @returns Function実行結果
	 */
	async remote(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): Promise<unknown> {
		this.#client.logger.debug(
			"Executing function call",
			"function_id",
			this.functionId,
		);
		this.#checkNoWebUrl("remote");
		const input = await this.#createInput(args, kwargs);
		const invocation = await this.#createRemoteInvocation(input);
		// TODO(ryan): リトライのテストを追加
		let retryCount = 0;
		while (true) {
			try {
				const result = await invocation.awaitOutput();
				this.#client.logger.debug(
					"Function call completed",
					"function_id",
					this.functionId,
				);
				return result;
			} catch (err) {
				if (err instanceof InternalFailure && retryCount <= maxSystemRetries) {
					this.#client.logger.debug(
						"Retrying function call due to internal failure",
						"function_id",
						this.functionId,
						"retry_count",
						retryCount,
					);
					await invocation.retry(retryCount);
					retryCount++;
				} else {
					throw err;
				}
			}
		}
	}

	async #createRemoteInvocation(input: FunctionInput): Promise<Invocation> {
		if (this.#handleMetadata?.inputPlaneUrl) {
			return await InputPlaneInvocation.create(
				this.#client,
				this.#handleMetadata.inputPlaneUrl,
				this.functionId,
				input,
			);
		}

		return await ControlPlaneInvocation.create(
			this.#client,
			this.functionId,
			input,
			FunctionCallInvocationType.FUNCTION_CALL_INVOCATION_TYPE_SYNC,
		);
	}

	/**
	 * @description Functionを非同期的にスポーンし、FunctionCallを返す
	 * @param args - 位置引数の配列
	 * @param kwargs - キーワード引数のマッピング
	 * @returns 非同期実行を追跡するFunctionCall
	 */
	async spawn(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): Promise<FunctionCall> {
		this.#client.logger.debug(
			"Spawning function call",
			"function_id",
			this.functionId,
		);
		this.#checkNoWebUrl("spawn");
		const input = await this.#createInput(args, kwargs);
		const invocation = await ControlPlaneInvocation.create(
			this.#client,
			this.functionId,
			input,
			FunctionCallInvocationType.FUNCTION_CALL_INVOCATION_TYPE_ASYNC,
		);
		this.#client.logger.debug(
			"Function call spawned",
			"function_id",
			this.functionId,
			"function_call_id",
			invocation.functionCallId,
		);
		return new FunctionCall(this.#client, invocation.functionCallId);
	}

	/**
	 * @description 各入力を Function に渡して結果を配列で返す
	 * @param inputs - 各 call の第一位置引数
	 */
	async map(inputs: Iterable<unknown>): Promise<unknown[]> {
		const calls = await Promise.all(
			Array.from(inputs, (input) => this.spawn([input])),
		);
		return await FunctionCall.gather(calls);
	}

	/**
	 * @description 各入力タプルを Function の位置引数として渡して結果を配列で返す
	 * @param inputs - 各 call の位置引数配列
	 */
	async starmap(inputs: Iterable<readonly unknown[]>): Promise<unknown[]> {
		const calls = await Promise.all(
			Array.from(inputs, (args) => this.spawn([...args])),
		);
		return await FunctionCall.gather(calls);
	}

	/**
	 * @description 各入力を Function に渡して完了を待つ。結果値は破棄する
	 * @param inputs - 各 call の第一位置引数
	 */
	async forEach(inputs: Iterable<unknown>): Promise<void> {
		await this.map(inputs);
	}

	/**
	 * @description {@link Function_#forEach} の Python 互換 alias
	 */
	async for_each(inputs: Iterable<unknown>): Promise<void> {
		await this.forEach(inputs);
	}

	/**
	 * @description Functionの現在の統計情報を取得する
	 * @returns バックログとランナー数を含む統計情報
	 */
	async getCurrentStats(): Promise<FunctionStats> {
		const resp = await this.#client.cpClient.functionGetCurrentStats(
			{ functionId: this.functionId },
			{ timeoutMs: 10000 },
		);
		return {
			backlog: resp.backlog,
			numTotalRunners: resp.numTotalTasks,
		};
	}

	/**
	 * @description Functionのオートスケーラー設定を更新する
	 * @param params - オートスケーラー設定
	 */
	async updateAutoscaler(
		params: FunctionUpdateAutoscalerParams,
	): Promise<void> {
		checkForRenamedParams(params, { scaledownWindow: "scaledownWindowMs" });

		await this.#client.cpClient.functionUpdateSchedulingParams({
			functionId: this.functionId,
			warmPoolSizeOverride: 0, // Deprecated field, always set to 0
			settings: {
				minContainers: params.minContainers,
				maxContainers: params.maxContainers,
				bufferContainers: params.bufferContainers,
				targetConcurrency: params.targetConcurrency,
				scaleupWindow:
					params.scaleupWindowMs !== undefined
						? Math.trunc(params.scaleupWindowMs / 1000)
						: undefined,
				scaledownWindow:
					params.scaledownWindowMs !== undefined
						? Math.trunc(params.scaledownWindowMs / 1000)
						: undefined,
			},
		});
	}

	/**
	 * @description Web エンドポイントとして実行されている Function の URL
	 * @returns Web エンドポイントの URL。Web エンドポイントでなければ undefined
	 */
	async getWebUrl(): Promise<string | undefined> {
		return this.#handleMetadata?.webUrl || undefined;
	}

	async #createInput(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): Promise<FunctionInput> {
		const supported_input_formats = this.#handleMetadata?.supportedInputFormats
			?.length
			? this.#handleMetadata.supportedInputFormats
			: [DataFormat.DATA_FORMAT_PICKLE];
		if (!supported_input_formats.includes(DataFormat.DATA_FORMAT_CBOR)) {
			// リモート Function が CBOR 入力に非対応なため早期エラー
			throw new InvalidError(
				"cannot call Modal Function from JS SDK since it was deployed with an incompatible Python SDK version. Redeploy with Modal Python SDK >= 1.2",
			);
		}
		const payload = cborEncode([args, kwargs]);

		let argsBlobId: string | undefined;
		if (payload.length > maxObjectSizeBytes) {
			argsBlobId = await blobUpload(this.#client.cpClient, payload);
		}

		return {
			args: argsBlobId ? undefined : payload,
			argsBlobId,
			dataFormat: DataFormat.DATA_FORMAT_CBOR,
			methodName: this.methodName,
			// Python SDK では未指定(デフォルト false)
			finalInput: false,
		};
	}
}

/**
 * @description 大きなペイロードをBlobストレージにアップロードする
 * @param cpClient - gRPCクライアント
 * @param data - アップロードするバイナリデータ
 * @returns Blob ID
 */
async function blobUpload(
	cpClient: ModalGrpcClient,
	data: Uint8Array,
): Promise<string> {
	const contentMd5 = createHash("md5").update(data).digest("base64");
	const contentSha256 = createHash("sha256").update(data).digest("base64");
	const resp = await cpClient.blobCreate({
		contentMd5,
		contentSha256Base64: contentSha256,
		contentLength: data.length,
	});
	if (resp.multipart) {
		throw new Error(
			"Function input size exceeds multipart upload threshold, unsupported by this SDK version",
		);
	} else if (resp.uploadUrl) {
		const uploadResp = await fetch(resp.uploadUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-MD5": contentMd5,
			},
			body: data,
		});
		if (uploadResp.status < 200 || uploadResp.status >= 300) {
			throw new Error(`Failed blob upload: ${uploadResp.statusText}`);
		}
		// クライアント側の ETag ヘッダー検証(MD5 チェックサム)は現在省略
		return resp.blobId;
	} else {
		throw new Error("Missing upload URL in BlobCreate response");
	}
}
