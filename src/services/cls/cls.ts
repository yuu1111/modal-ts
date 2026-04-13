import type { ModalClient } from "@/core/client";
import { NotFoundError, rethrowNotFound } from "@/core/errors";
import {
	ClassParameterInfo_ParameterSerializationFormat,
	ClassParameterSet,
	type ClassParameterSpec,
	type ClassParameterValue,
	type FunctionHandleMetadata,
	FunctionOptions,
	type FunctionRetryPolicy,
	ParameterType,
	type VolumeMount,
} from "@/generated/modal_proto/api";
import { parseGpuConfig } from "@/services/deploy/app";
import { Function_ } from "@/services/function/function";
import type { Secret } from "@/services/secret/secret";
import { mergeEnvIntoSecrets } from "@/services/secret/secret";
import type { Volume } from "@/services/volume/volume";
import { parseRetries, type Retries } from "@/utils/retries";
import { checkForRenamedParams } from "@/utils/validation";

/**
 * @description {@link ClsService#fromName client.cls.fromName()} のオプションパラメータ
 * @property environment - Modal環境名 @optional
 * @property createIfMissing - 存在しない場合に作成するかどうか @optional
 */
export type ClsFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * Service for managing {@link Cls}.
 *
 * Normally only ever accessed via the client as:
 * ```typescript
 * const modal = new ModalClient();
 * const cls = await modal.cls.fromName("my-app", "MyCls");
 * ```
 */
export class ClsService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * Reference a {@link Cls} from a deployed {@link App} by its name.
	 */
	async fromName(
		appName: string,
		name: string,
		params: ClsFromNameParams = {},
	): Promise<Cls> {
		try {
			const serviceFunctionName = `${name}.*`;
			const serviceFunction = await this.#client.cpClient.functionGet({
				appName,
				objectTag: serviceFunctionName,
				environmentName: this.#client.environmentName(params.environment),
			});

			const parameterInfo = serviceFunction.handleMetadata?.classParameterInfo;
			const schema = parameterInfo?.schema ?? [];
			if (
				schema.length > 0 &&
				parameterInfo?.format !==
					ClassParameterInfo_ParameterSerializationFormat.PARAM_SERIALIZATION_FORMAT_PROTO
			) {
				throw new Error(
					`Unsupported parameter format: ${parameterInfo?.format}`,
				);
			}

			this.#client.logger.debug(
				"Retrieved Cls",
				"function_id",
				serviceFunction.functionId,
				"app_name",
				appName,
				"cls_name",
				name,
			);
			const handleMetadata = serviceFunction.handleMetadata;
			if (!handleMetadata) {
				throw new Error(
					`Missing handle metadata for class '${appName}/${name}'`,
				);
			}
			return new Cls(
				this.#client,
				serviceFunction.functionId,
				handleMetadata,
				undefined,
			);
		} catch (err) {
			rethrowNotFound(err, `Class '${appName}/${name}' not found`);
		}
	}
}

/**
 * @description Cls のランタイムオプション上書きパラメータ
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
 */
export type ClsWithOptionsParams = {
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
};

/**
 * @description Cls の同時実行設定パラメータ
 * @property maxInputs - 最大同時入力数
 * @property targetInputs - 目標同時入力数 @optional
 */
export type ClsWithConcurrencyParams = {
	maxInputs: number;
	targetInputs?: number;
};

/**
 * @description Cls のダイナミックバッチング設定パラメータ
 * @property maxBatchSize - 最大バッチサイズ
 * @property waitMs - バッチ待機時間(ミリ秒)
 */
export type ClsWithBatchingParams = {
	maxBatchSize: number;
	waitMs: number;
};

/**
 * @description Cls サービスの内部オプション(公開パラメータ + 内部フィールド)
 */
type ServiceOptions = ClsWithOptionsParams & {
	maxConcurrentInputs?: number;
	targetConcurrentInputs?: number;
	batchMaxSize?: number;
	batchWaitMs?: number;
};

/**
 * @description デプロイ済みの Modal Cls を表すクラス
 */
export class Cls {
	#client: ModalClient;
	#serviceFunctionId: string;
	#serviceFunctionMetadata: FunctionHandleMetadata;
	#serviceOptions?: ServiceOptions;

	/** @internal */
	constructor(
		client: ModalClient,
		serviceFunctionId: string,
		serviceFunctionMetadata: FunctionHandleMetadata,
		options?: ServiceOptions,
	) {
		this.#client = client;
		this.#serviceFunctionId = serviceFunctionId;
		this.#serviceFunctionMetadata = serviceFunctionMetadata;
		if (options !== undefined) this.#serviceOptions = options;
	}

	get #schema(): ClassParameterSpec[] {
		return this.#serviceFunctionMetadata.classParameterInfo?.schema ?? [];
	}

	/**
	 * @description パラメータやランタイムオプションを適用した Cls インスタンスを生成する
	 * @param parameters - Cls コンストラクタに渡すパラメータ
	 * @returns Cls インスタンス
	 */
	async instance(
		parameters: Record<string, unknown> = {},
	): Promise<ClsInstance> {
		let functionId: string;
		if (this.#schema.length === 0 && this.#serviceOptions === undefined) {
			functionId = this.#serviceFunctionId;
		} else {
			functionId = await this.#bindParameters(parameters);
		}

		const methods = new Map<string, Function_>();
		for (const [name, methodMetadata] of Object.entries(
			this.#serviceFunctionMetadata.methodHandleMetadata,
		)) {
			methods.set(
				name,
				new Function_(this.#client, functionId, name, methodMetadata),
			);
		}
		return new ClsInstance(methods);
	}

	/**
	 * @description 静的な Function 設定をランタイムで上書きする
	 * @param options - 上書きオプション
	 * @returns 新しいオプションが適用された Cls
	 */
	withOptions(options: ClsWithOptionsParams): Cls {
		const merged = mergeServiceOptions(this.#serviceOptions, options);
		return new Cls(
			this.#client,
			this.#serviceFunctionId,
			this.#serviceFunctionMetadata,
			merged,
		);
	}

	/**
	 * @description 同時実行設定を有効化または上書きした Cls を返す
	 * @param params - 同時実行パラメータ
	 * @returns 同時実行設定が適用された Cls
	 */
	withConcurrency(params: ClsWithConcurrencyParams): Cls {
		const merged = mergeServiceOptions(this.#serviceOptions, {
			maxConcurrentInputs: params.maxInputs,
			...(params.targetInputs !== undefined && {
				targetConcurrentInputs: params.targetInputs,
			}),
		});
		return new Cls(
			this.#client,
			this.#serviceFunctionId,
			this.#serviceFunctionMetadata,
			merged,
		);
	}

	/**
	 * @description ダイナミックバッチングを有効化または上書きした Cls を返す
	 * @param params - バッチングパラメータ
	 * @returns バッチング設定が適用された Cls
	 */
	withBatching(params: ClsWithBatchingParams): Cls {
		const merged = mergeServiceOptions(this.#serviceOptions, {
			batchMaxSize: params.maxBatchSize,
			batchWaitMs: params.waitMs,
		});
		return new Cls(
			this.#client,
			this.#serviceFunctionId,
			this.#serviceFunctionMetadata,
			merged,
		);
	}

	/**
	 * @description パラメータを Cls 関数にバインドする
	 * @param parameters - バインドするパラメータ
	 * @returns バインドされた関数ID
	 */
	async #bindParameters(parameters: Record<string, unknown>): Promise<string> {
		const mergedSecrets = await mergeEnvIntoSecrets(
			this.#client,
			this.#serviceOptions?.env,
			this.#serviceOptions?.secrets,
		);
		const mergedOptions = mergeServiceOptions(this.#serviceOptions, {
			secrets: mergedSecrets,
		});

		const serializedParams = encodeParameterSet(this.#schema, parameters);
		const functionOptions = await buildFunctionOptionsProto(mergedOptions);
		const bindResp = await this.#client.cpClient.functionBindParams({
			functionId: this.#serviceFunctionId,
			serializedParams,
			functionOptions,
			environmentName: this.#client.environmentName(),
		});
		return bindResp.boundFunctionId;
	}
}

/**
 * @description Cls パラメータスキーマに基づいてパラメータセットをエンコードする
 * @param schema - パラメータスキーマ
 * @param params - エンコードするパラメータ
 * @returns シリアライズされたバイト列
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
	// Sort keys, identical to Python `SerializeToString(deterministic=True)`.
	encoded.sort((a, b) => a.name.localeCompare(b.name));
	return ClassParameterSet.encode({ parameters: encoded }).finish();
}

/**
 * @description ベースオプションに差分をマージする
 * @param base - ベースオプション
 * @param diff - マージする差分
 * @returns マージ結果(空の場合は undefined)
 */
function mergeServiceOptions(
	base: ServiceOptions | undefined,
	diff: Partial<ServiceOptions>,
): ServiceOptions | undefined {
	const filteredDiff = Object.fromEntries(
		Object.entries(diff).filter(([, value]) => value !== undefined),
	) as Partial<ServiceOptions>;
	const merged = { ...(base ?? {}), ...filteredDiff } as ServiceOptions;
	return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * @description ServiceOptions から gRPC FunctionOptions プロトコルバッファを構築する
 * @param options - サービスオプション
 * @returns FunctionOptions プロトメッセージ(オプションが空の場合は undefined)
 */
async function buildFunctionOptionsProto(
	options?: ServiceOptions,
): Promise<FunctionOptions | undefined> {
	if (!options) return undefined;
	const o = options ?? {};

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
		? Object.entries(o.volumes).map(([mountPath, volume]) => ({
				volumeId: volume.volumeId,
				mountPath,
				allowBackgroundCommits: true,
				readOnly: volume.isReadOnly,
			}))
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

	const functionOptions = FunctionOptions.create({
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
	});

	return functionOptions;
}

/**
 * @description パラメータスペックに基づいて単一パラメータをエンコードする
 * @param paramSpec - パラメータのスキーマ定義
 * @param value - エンコードする値
 * @returns エンコードされたパラメータ値
 */
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
 * @description デプロイ済み Modal {@link Cls} のインスタンス(パラメータ適用済み)
 */
export class ClsInstance {
	#methods: Map<string, Function_>;

	constructor(methods: Map<string, Function_>) {
		this.#methods = methods;
	}

	/**
	 * @description 名前を指定してメソッドを取得する
	 * @param name - メソッド名
	 * @returns メソッドに対応する Function
	 * @throws メソッドが見つからない場合は {@link NotFoundError}
	 */
	method(name: string): Function_ {
		const method = this.#methods.get(name);
		if (!method) {
			throw new NotFoundError(`Method '${name}' not found on class`);
		}
		return method;
	}
}
