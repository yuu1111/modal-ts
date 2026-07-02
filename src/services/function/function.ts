import { createHash } from "node:crypto";
import {
	getDefaultClient,
	type ModalClient,
	type ModalGrpcClient,
} from "@/core/client";
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
import type { DeployFunctionParams } from "@/services/deploy/deploy";
import {
	type LocalFunctionParams,
	type LocalFunctionSource,
	localFunctionRuntime,
} from "@/services/deploy/local";
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

	/**
	 * @description local JavaScript/TypeScript function を deployApp 用の定義に変換する
	 */
	static from_local(
		source: LocalFunctionSource,
		params: LocalFunctionParams = {},
	): DeployFunctionParams {
		const local = localFunctionRuntime(source, params);
		return {
			functionName: local.functionName,
			moduleName: local.moduleName,
			implementationName: local.localRuntime.implementationName,
			localRuntime: local.localRuntime,
			...(params.image !== undefined && { image: params.image }),
			...(params.imageId !== undefined && { imageId: params.imageId }),
			...(params.mountIds !== undefined && { mountIds: params.mountIds }),
			...(params.secrets !== undefined && { secrets: params.secrets }),
			...(params.env !== undefined && { env: params.env }),
			...(params.secretIds !== undefined && { secretIds: params.secretIds }),
			...(params.minContainers !== undefined && {
				minContainers: params.minContainers,
			}),
			...(params.schedule !== undefined && { schedule: params.schedule }),
			...(params.schedulerPlacement !== undefined && {
				schedulerPlacement: params.schedulerPlacement,
			}),
			...(params.experimentalOptions !== undefined && {
				experimentalOptions: params.experimentalOptions,
			}),
		};
	}

	static fromLocal(
		source: LocalFunctionSource,
		params: LocalFunctionParams = {},
	): DeployFunctionParams {
		return Function_.from_local(source, params);
	}

	/**
	 * @description deployed Function を名前で取得する Python 互換 helper
	 */
	static async from_name(
		appName: string,
		name: string,
		params: FunctionFromNameParams = {},
	): Promise<Function_> {
		return await getDefaultClient().functions.fromName(appName, name, params);
	}

	/**
	 * @description Function のタグ名
	 */
	get tag(): string | undefined {
		return this.#handleMetadata?.functionName;
	}

	/**
	 * @description Python の古い `stub` alias 互換
	 */
	get stub(): undefined {
		return undefined;
	}

	/**
	 * @description Function handle のメタデータを返す
	 */
	info(): Record<string, unknown> {
		return {
			functionId: this.functionId,
			methodName: this.methodName,
			webUrl: this.#handleMetadata?.webUrl,
			functionName: this.#handleMetadata?.functionName,
		};
	}

	/**
	 * @description Function spec 相当の軽量情報を返す
	 */
	spec(): Record<string, unknown> {
		return this.info();
	}

	/**
	 * @description build definition はTS handleでは保持しないため undefined を返す
	 */
	get_build_def(): undefined {
		return undefined;
	}

	/**
	 * @description generator Function かどうか
	 */
	is_generator(): boolean {
		return false;
	}

	/**
	 * @description raw local function はTS handleでは保持しないため undefined を返す
	 */
	get_raw_f(): undefined {
		return undefined;
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

	with_options(options: FunctionWithOptionsParams): Function_ {
		return this.withOptions(options);
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

	with_concurrency(params: FunctionWithConcurrencyParams): Function_ {
		return this.withConcurrency(params);
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

	with_batching(params: FunctionWithBatchingParams): Function_ {
		return this.withBatching(params);
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

	/**
	 * @description generator API 互換。結果が iterable なら順に yield する
	 */
	async *remote_gen(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): AsyncGenerator<unknown, void, unknown> {
		const result = await this.remote(args, kwargs);
		if (result && typeof result === "object" && Symbol.iterator in result) {
			yield* result as Iterable<unknown>;
		} else {
			yield result;
		}
	}

	/**
	 * @description local 実行互換。TS handleでは remote と同じ経路を使う
	 */
	async local(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): Promise<unknown> {
		return await this.remote(args, kwargs);
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

	async get_current_stats(): Promise<FunctionStats> {
		return await this.getCurrentStats();
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

	async update_autoscaler(
		params: FunctionUpdateAutoscalerParams,
	): Promise<void> {
		await this.updateAutoscaler(params);
	}

	/**
	 * @description Web エンドポイントとして実行されている Function の URL
	 * @returns Web エンドポイントの URL。Web エンドポイントでなければ undefined
	 */
	async getWebUrl(): Promise<string | undefined> {
		return this.#handleMetadata?.webUrl || undefined;
	}

	async get_web_url(): Promise<string | undefined> {
		return await this.getWebUrl();
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
	if (resp.multiparts?.items.length) {
		const blobIds =
			(resp.blobIds?.length ?? 0) > 0 ? resp.blobIds : [resp.blobId];
		return await uploadWithFallback(resp.multiparts.items, blobIds, (item) =>
			performMultipartUpload(data, item),
		);
	}
	if (resp.multipart) {
		await performMultipartUpload(data, resp.multipart);
		return resp.blobId;
	}
	const uploadUrls =
		resp.uploadUrls?.items ?? (resp.uploadUrl ? [resp.uploadUrl] : []);
	if (uploadUrls.length > 0) {
		const blobIds =
			(resp.blobIds?.length ?? 0) > 0 ? resp.blobIds : [resp.blobId];
		return await uploadWithFallback(uploadUrls, blobIds, (url) =>
			uploadSingleBlobPart(url, data, contentMd5),
		);
	}
	throw new Error("Missing upload URL in BlobCreate response");
}

async function uploadWithFallback<T>(
	items: T[],
	blobIds: string[],
	callback: (item: T) => Promise<void>,
): Promise<string> {
	let lastError: unknown;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item === undefined) continue;
		try {
			await callback(item);
			return blobIds[index] ?? blobIds[0] ?? "";
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Failed blob upload");
}

async function uploadSingleBlobPart(
	url: string,
	data: Uint8Array,
	contentMd5: string,
): Promise<void> {
	const uploadResp = await fetch(url, {
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
}

async function performMultipartUpload(
	data: Uint8Array,
	multipart: {
		partLength: number;
		uploadUrls: string[];
		completionUrl: string;
	},
): Promise<void> {
	const partEtags = await Promise.all(
		multipart.uploadUrls.map(async (url, index) => {
			const start = index * multipart.partLength;
			const part = data.subarray(
				start,
				Math.min(start + multipart.partLength, data.length),
			);
			return await uploadMultipartPart(url, part);
		}),
	);
	const completionBody = [
		"<CompleteMultipartUpload>",
		...partEtags.map(
			(etag, index) =>
				`<Part>\n<PartNumber>${index + 1}</PartNumber>\n<ETag>"${etag}"</ETag>\n</Part>`,
		),
		"</CompleteMultipartUpload>",
	].join("\n");
	const expectedEtag = `${createHash("md5")
		.update(Buffer.concat(partEtags.map((etag) => Buffer.from(etag, "hex"))))
		.digest("hex")}-${partEtags.length}`;
	const completionResp = await fetch(multipart.completionUrl, {
		method: "POST",
		body: completionBody,
	});
	if (!completionResp.ok) {
		throw new Error(
			`Failed completing multipart blob upload: ${completionResp.status}`,
		);
	}
	const body = await completionResp.text();
	if (!body.includes(expectedEtag)) {
		throw new Error(`Multipart blob upload checksum mismatch: ${expectedEtag}`);
	}
}

async function uploadMultipartPart(
	url: string,
	data: Uint8Array,
): Promise<string> {
	const uploadResp = await fetch(url, {
		method: "PUT",
		body: data,
	});
	if (!uploadResp.ok) {
		throw new Error(`Failed multipart blob upload: ${uploadResp.statusText}`);
	}
	const etag = uploadResp.headers
		.get("ETag")
		?.trim()
		.replace(/^W\//i, "")
		.replace(/^"|"$/g, "");
	if (!etag) throw new Error("Multipart blob upload response missing ETag");
	const localMd5 = createHash("md5").update(data).digest("hex");
	if (etag !== localMd5) {
		throw new Error(`Multipart blob upload checksum mismatch: ${localMd5}`);
	}
	return etag;
}
