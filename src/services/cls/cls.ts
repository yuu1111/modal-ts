import { getDefaultClient, type ModalClient } from "@/core/client";
import { NotFoundError } from "@/core/errors";
import { rethrowNotFound } from "@/core/grpc/errors";
import {
	ClassParameterInfo_ParameterSerializationFormat,
	type ClassParameterSpec,
	type FunctionHandleMetadata,
} from "@/generated/modal_proto/api";
import type { DeployClassParams } from "@/services/deploy/deploy";
import {
	type LocalClassParams,
	type LocalClassSource,
	localClassRuntime,
} from "@/services/deploy/local";
import { Function_ } from "@/services/function/function";
import {
	buildFunctionOptionsProto,
	encodeParameterSet,
	mergeServiceOptions,
	type ServiceOptions,
} from "@/services/function/options";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import type { Secret } from "@/services/secret/secret";
import { mergeEnvIntoSecrets } from "@/services/secret/secret";
import type { Volume } from "@/services/volume/volume";
import { aliasedNumber, environmentParam } from "@/utils/param_aliases";
import type { Retries } from "@/utils/retries";

export { encodeParameterSet } from "@/services/function/options";

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
type ClsServiceOptions = ClsWithOptionsParams & ServiceOptions;

/**
 * Represents a deployed Modal Cls
 */
export class Cls {
	#client: ModalClient;
	#serviceFunctionId: string;
	#serviceFunctionMetadata: FunctionHandleMetadata;
	#serviceOptions?: ClsServiceOptions;

	/** @internal */
	constructor(
		client: ModalClient,
		serviceFunctionId: string,
		serviceFunctionMetadata: FunctionHandleMetadata,
		options?: ClsServiceOptions,
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
		const diff: Partial<ClsServiceOptions> = {};
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
		const diff: Partial<ClsServiceOptions> = {};
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
