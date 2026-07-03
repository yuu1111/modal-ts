import { getDefaultClient, type ModalClient } from "@/core/client";
import { NotFoundError } from "@/core/errors";
import { rethrowNotFound } from "@/core/grpc/errors";
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
import type { DeployClassParams } from "@/services/deploy/deploy";
import {
	type LocalClassParams,
	type LocalClassSource,
	localClassRuntime,
} from "@/services/deploy/local";
import { Function_ } from "@/services/function/function";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import type { Secret } from "@/services/secret/secret";
import { mergeEnvIntoSecrets } from "@/services/secret/secret";
import { type Volume, volumeToMountProto } from "@/services/volume/volume";
import { aliasedNumber, environmentParam } from "@/utils/param_aliases";
import { parseRetries, type Retries } from "@/utils/retries";
import { checkForRenamedParams } from "@/utils/validation";

/**
 * Optional parameters for {@link ClsService#fromName client.cls.fromName()}
 * @property environment - Modal environment name
 * @property createIfMissing - Whether to create when missing
 */
export type ClsFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	createIfMissing?: boolean;
	create_if_missing?: boolean;
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
				environmentName: this.#client.environmentName(environmentParam(params)),
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

	async from_name(
		appName: string,
		name: string,
		params: ClsFromNameParams = {},
	): Promise<Cls> {
		return await this.fromName(appName, name, params);
	}
}

/**
 * Parameters for overriding Cls runtime options
 * @property cpu - CPU core count
 * @property cpuLimit - Upper limit for CPU cores
 * @property memoryMiB - Memory in MiB
 * @property memoryLimitMiB - Memory limit in MiB
 * @property gpu - GPU settings string
 * @property env - Environment variables
 * @property secrets - Secrets
 * @property volumes - Volume mounts
 * @property retries - Retry policy
 * @property maxContainers - Maximum container count
 * @property bufferContainers - Buffer container count
 * @property scaledownWindowMs - Scale-down wait time in milliseconds
 * @property timeoutMs - Timeout in milliseconds
 * @property schedulerPlacement - Scheduling constraints
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
	max_containers?: number;
	bufferContainers?: number;
	buffer_containers?: number;
	scaledownWindowMs?: number;
	scaledown_window?: number;
	scaledown_window_ms?: number;
	timeoutMs?: number;
	schedulerPlacement?: SchedulerPlacement;
};

/**
 * Concurrency settings for Cls
 * @property maxInputs - Maximum concurrent input count
 * @property targetInputs - Target concurrent input count
 */
export type ClsWithConcurrencyParams = {
	maxInputs?: number;
	max_inputs?: number;
	targetInputs?: number;
	target_inputs?: number;
};

/**
 * Dynamic batching settings for Cls
 * @property maxBatchSize - Maximum batch size
 * @property waitMs - Batch wait time in milliseconds
 */
export type ClsWithBatchingParams = {
	maxBatchSize?: number;
	max_batch_size?: number;
	waitMs?: number;
	wait_ms?: number;
};

/**
 * Internal Cls service options, combining public parameters and internal fields
 */
type ServiceOptions = ClsWithOptionsParams & {
	maxConcurrentInputs?: number;
	max_concurrent_inputs?: number;
	targetConcurrentInputs?: number;
	target_concurrent_inputs?: number;
	batchMaxSize?: number;
	batch_max_size?: number;
	batchWaitMs?: number;
	batch_wait_ms?: number;
};

/**
 * Represents a deployed Modal Cls
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

	static validate_construction_mechanism(): void {}

	static validateConstructionMechanism(): void {
		Cls.validate_construction_mechanism();
	}

	static from_local(
		source: LocalClassSource,
		params: LocalClassParams = {},
	): DeployClassParams {
		const local = localClassRuntime(source, params);
		return {
			className: local.className,
			moduleName: local.moduleName,
			methods: local.methods,
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
			...(params.schedulerPlacement !== undefined && {
				schedulerPlacement: params.schedulerPlacement,
			}),
			...(params.experimentalOptions !== undefined && {
				experimentalOptions: params.experimentalOptions,
			}),
		};
	}

	static fromLocal(
		source: LocalClassSource,
		params: LocalClassParams = {},
	): DeployClassParams {
		return Cls.from_local(source, params);
	}

	static async from_name(
		appName: string,
		name: string,
		params: ClsFromNameParams = {},
	): Promise<Cls> {
		return await getDefaultClient().cls.fromName(appName, name, params);
	}

	static async fromName(
		appName: string,
		name: string,
		params: ClsFromNameParams = {},
	): Promise<Cls> {
		return await Cls.from_name(appName, name, params);
	}

	get #schema(): ClassParameterSpec[] {
		return this.#serviceFunctionMetadata.classParameterInfo?.schema ?? [];
	}

	/**
	 * Creates a Cls instance with parameters and runtime options applied
	 * @param parameters - Parameters passed to the Cls constructor
	 * @returns Cls instance
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
	 * Overrides static Function settings at runtime
	 * @param options - Override options
	 * @returns Cls with the new options applied
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

	with_options(options: ClsWithOptionsParams): Cls {
		return this.withOptions(options);
	}

	/**
	 * Returns a Cls with concurrency settings enabled or overridden
	 * @param params - Concurrency parameters
	 * @returns Cls with concurrency settings applied
	 */
	withConcurrency(params: ClsWithConcurrencyParams): Cls {
		const maxInputs = aliasedNumber(params, "maxInputs", "max_inputs");
		const targetInputs = aliasedNumber(params, "targetInputs", "target_inputs");
		const diff: Partial<ServiceOptions> = {};
		if (maxInputs !== undefined) diff.maxConcurrentInputs = maxInputs;
		if (targetInputs !== undefined) diff.targetConcurrentInputs = targetInputs;
		const merged = mergeServiceOptions(this.#serviceOptions, diff);
		return new Cls(
			this.#client,
			this.#serviceFunctionId,
			this.#serviceFunctionMetadata,
			merged,
		);
	}

	with_concurrency(params: ClsWithConcurrencyParams): Cls {
		return this.withConcurrency(params);
	}

	/**
	 * Returns a Cls with dynamic batching enabled or overridden
	 * @param params - Batching parameters
	 * @returns Cls with batching settings applied
	 */
	withBatching(params: ClsWithBatchingParams): Cls {
		const maxBatchSize = aliasedNumber(
			params,
			"maxBatchSize",
			"max_batch_size",
		);
		const waitMs = aliasedNumber(params, "waitMs", "wait_ms");
		const diff: Partial<ServiceOptions> = {};
		if (maxBatchSize !== undefined) diff.batchMaxSize = maxBatchSize;
		if (waitMs !== undefined) diff.batchWaitMs = waitMs;
		const merged = mergeServiceOptions(this.#serviceOptions, diff);
		return new Cls(
			this.#client,
			this.#serviceFunctionId,
			this.#serviceFunctionMetadata,
			merged,
		);
	}

	with_batching(params: ClsWithBatchingParams): Cls {
		return this.withBatching(params);
	}

	/**
	 * Binds parameters to the Cls function
	 * @param parameters - Parameters to bind
	 * @returns Bound function ID
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
 * Encodes a parameter set based on the Cls parameter schema
 * @param schema - Parameter schema
 * @param params - Parameters to encode
 * @returns Serialized bytes
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
 * Merges a diff into base options
 * @param base - Base options
 * @param diff - Diff to merge
 * @returns Merged result, or undefined when empty
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

function secondsAliasToMs(
	params: Record<string, unknown>,
	msName: string,
	secondsName: string,
): number | undefined {
	const ms =
		aliasedNumber(params, msName, `${secondsName}_ms`) ??
		aliasedNumber(params, secondsName);
	if (ms === undefined) return undefined;
	return msName in params || `${secondsName}_ms` in params ? ms : ms * 1000;
}

function normalizeServiceOptions(options: ServiceOptions): ServiceOptions {
	const normalized: ServiceOptions = {
		...options,
	};
	const maxContainers = aliasedNumber(
		options,
		"maxContainers",
		"max_containers",
	);
	if (maxContainers !== undefined) normalized.maxContainers = maxContainers;
	const bufferContainers = aliasedNumber(
		options,
		"bufferContainers",
		"buffer_containers",
	);
	if (bufferContainers !== undefined)
		normalized.bufferContainers = bufferContainers;
	const scaledownWindowMs =
		secondsAliasToMs(options, "scaledownWindowMs", "scaledown_window") ??
		options.scaledownWindowMs;
	if (scaledownWindowMs !== undefined)
		normalized.scaledownWindowMs = scaledownWindowMs;
	const timeoutMs =
		secondsAliasToMs(options, "timeoutMs", "timeout") ?? options.timeoutMs;
	if (timeoutMs !== undefined) normalized.timeoutMs = timeoutMs;
	const maxConcurrentInputs = aliasedNumber(
		options,
		"maxConcurrentInputs",
		"max_concurrent_inputs",
	);
	if (maxConcurrentInputs !== undefined)
		normalized.maxConcurrentInputs = maxConcurrentInputs;
	const targetConcurrentInputs = aliasedNumber(
		options,
		"targetConcurrentInputs",
		"target_concurrent_inputs",
	);
	if (targetConcurrentInputs !== undefined)
		normalized.targetConcurrentInputs = targetConcurrentInputs;
	const batchMaxSize = aliasedNumber(options, "batchMaxSize", "batch_max_size");
	if (batchMaxSize !== undefined) normalized.batchMaxSize = batchMaxSize;
	const batchWaitMs =
		secondsAliasToMs(options, "batchWaitMs", "batch_wait") ??
		options.batchWaitMs;
	if (batchWaitMs !== undefined) normalized.batchWaitMs = batchWaitMs;
	return normalized;
}

/**
 * Builds a gRPC FunctionOptions protobuf from ServiceOptions
 * @param options - Service options
 * @returns FunctionOptions proto message, or undefined when options are empty
 */
async function buildFunctionOptionsProto(
	options?: ServiceOptions,
): Promise<FunctionOptions | undefined> {
	if (!options) return undefined;
	const o = normalizeServiceOptions(options);

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
		schedulerPlacement: o.schedulerPlacement?.toProto(),
	});

	return functionOptions;
}

/**
 * Encodes a single parameter based on its parameter spec
 * @param paramSpec - Parameter schema definition
 * @param value - Value to encode
 * @returns Encoded parameter value
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
 * Instance of a deployed Modal {@link Cls} with parameters applied
 */
export class ClsInstance {
	#methods: Map<string, Function_>;

	constructor(methods: Map<string, Function_>) {
		this.#methods = methods;
	}

	/**
	 * Gets a method by name
	 * @param name - Method name
	 * @returns Function corresponding to the method
	 * @throws {@link NotFoundError} when the method is not found
	 */
	method(name: string): Function_ {
		const method = this.#methods.get(name);
		if (!method) {
			throw new NotFoundError(`Method '${name}' not found on class`);
		}
		return method;
	}

	async update_autoscaler(
		params: Parameters<Function_["updateAutoscaler"]>[0],
	): Promise<void> {
		for (const fn of this.#methods.values()) {
			await fn.updateAutoscaler(params);
		}
	}
}
