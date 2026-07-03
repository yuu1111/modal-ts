import { createHash } from "node:crypto";
import {
	getDefaultClient,
	type ModalClient,
	type ModalGrpcClient,
} from "@/core/client";
import { InternalFailure, InvalidError } from "@/core/errors";
import { rethrowNotFound } from "@/core/grpc/errors";
import {
	type ClassParameterSpec,
	DataFormat,
	FunctionCallInvocationType,
	type FunctionHandleMetadata,
	type FunctionInput,
} from "@/generated/modal_proto/api";
import type { DeployFunctionParams } from "@/services/deploy/deploy";
import {
	type LocalFunctionParams,
	type LocalFunctionSource,
	localFunctionRuntime,
} from "@/services/deploy/local";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import { mergeEnvIntoSecrets, type Secret } from "@/services/secret/secret";
import type { Volume } from "@/services/volume/volume";
import { aliasedNumber, environmentParam } from "@/utils/param_aliases";
import type { Retries } from "@/utils/retries";
import { cborEncode } from "@/utils/serialization";
import { FunctionCall } from "./function_call";
import {
	ControlPlaneInvocation,
	InputPlaneInvocation,
	type Invocation,
} from "./invocation";
import {
	buildFunctionOptionsProto,
	encodeParameterSet,
	mergeServiceOptions,
	type ServiceOptions,
	secondsAliasToMs,
} from "./options";

export {
	buildFunctionOptionsProto,
	encodeParameterSet,
	mergeServiceOptions,
} from "./options";

/**
 * Threshold for blob uploads
 */
const maxObjectSizeBytes = 2 * 1024 * 1024; // 2 MiB

/**
 * Maximum retry count for InternalFailure
 */
const maxSystemRetries = 8;

/**
 * Optional parameters for `client.functions.fromName()`
 * @property environment - Environment name
 * @property createIfMissing - Whether to create when missing
 */
export type FunctionFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	createIfMissing?: boolean;
	create_if_missing?: boolean;
};

/**
 * Service for managing {@link Function_}
 *
 * Usually accessed only through the client:
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
	 * Gets a Function in an App by name
	 * @param appName - App name
	 * @param name - Function name
	 * @param params - Optional parameters
	 * @returns Function instance
	 * @throws NotFoundError when the specified Function does not exist
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
				environmentName: this.#client.environmentName(environmentParam(params)),
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
 * Runtime statistics for a Function
 * @property backlog - Number of pending inputs
 * @property numTotalRunners - Total number of runners
 */
export interface FunctionStats {
	backlog: number;
	numTotalRunners: number;
}

/**
 * Parameters for updating the autoscaler
 * @property minContainers - Minimum container count
 * @property maxContainers - Maximum container count
 * @property bufferContainers - Buffer container count
 * @property targetConcurrency - Target concurrent request count
 * @property scaleupWindowMs - Scale-up grace period in milliseconds
 * @property scaledownWindowMs - Scale-down grace period in milliseconds
 */
export interface FunctionUpdateAutoscalerParams {
	minContainers?: number;
	min_containers?: number;
	maxContainers?: number;
	max_containers?: number;
	bufferContainers?: number;
	buffer_containers?: number;
	targetConcurrency?: number;
	target_concurrency?: number;
	scaleupWindowMs?: number;
	scaleup_window?: number;
	scaleup_window_ms?: number;
	scaledownWindowMs?: number;
	scaledown_window?: number;
	scaledown_window_ms?: number;
}

/**
 * Parameters for overriding Function runtime options
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
 * Function concurrency settings
 * @property maxInputs - Maximum concurrent input count
 * @property targetInputs - Target concurrent input count
 */
export type FunctionWithConcurrencyParams = {
	maxInputs?: number;
	max_inputs?: number;
	targetInputs?: number;
	target_inputs?: number;
};

/**
 * Function dynamic batching settings
 * @property maxBatchSize - Maximum batch size
 * @property waitMs - Batch wait time in milliseconds
 */
export type FunctionWithBatchingParams = {
	maxBatchSize?: number;
	max_batch_size?: number;
	waitMs?: number;
	wait_ms?: number;
};

/**
 * Internal Function options, combining public parameters and internal fields
 */
export type FunctionOptions = FunctionWithOptionsParams & ServiceOptions;

/**
 * Binds parameters and runtime options to a Function
 * @param client - Modal client
 * @param functionId - Function ID
 * @param options - Runtime options
 * @param schema - Parameter schema
 * @param parameters - Parameters to bind
 * @returns Binding result
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
 * Represents a deployed Modal Function that can be executed remotely
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
	 * Converts a local JavaScript/TypeScript function into a definition for deployApp
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
	 * Python-compatible helper that gets a deployed Function by name
	 */
	static async from_name(
		appName: string,
		name: string,
		params: FunctionFromNameParams = {},
	): Promise<Function_> {
		return await getDefaultClient().functions.fromName(appName, name, params);
	}

	static async fromName(
		appName: string,
		name: string,
		params: FunctionFromNameParams = {},
	): Promise<Function_> {
		return await Function_.from_name(appName, name, params);
	}

	/**
	 * Tag name for the Function
	 */
	get tag(): string | undefined {
		return this.#handleMetadata?.functionName;
	}

	/**
	 * Compatibility with Python's old `stub` alias
	 */
	get stub(): undefined {
		return undefined;
	}

	/**
	 * Returns metadata for the Function handle
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
	 * Returns lightweight information equivalent to a Function spec
	 */
	spec(): Record<string, unknown> {
		return this.info();
	}

	/**
	 * Returns undefined because TS handles do not keep the build definition
	 */
	get_build_def(): undefined {
		return undefined;
	}

	getBuildDef(): undefined {
		return this.get_build_def();
	}

	/**
	 * Whether this is a generator Function
	 */
	is_generator(): boolean {
		return false;
	}

	isGenerator(): boolean {
		return this.is_generator();
	}

	/**
	 * Returns undefined because TS handles do not keep the raw local function
	 */
	get_raw_f(): undefined {
		return undefined;
	}

	getRawF(): undefined {
		return this.get_raw_f();
	}

	#checkNoWebUrl(fnName: string): void {
		if (this.#handleMetadata?.webUrl) {
			throw new InvalidError(
				`A webhook Function cannot be invoked for remote execution with '.${fnName}'. Invoke this Function via its web url '${this.#handleMetadata.webUrl}' instead.`,
			);
		}
	}

	/**
	 * Overrides static Function settings at runtime
	 * @param options - Override options
	 * @returns Function with the new options applied
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
	 * Returns a Function with concurrency settings enabled or overridden
	 * @param params - Concurrency parameters
	 * @returns Function with concurrency settings applied
	 */
	withConcurrency(params: FunctionWithConcurrencyParams): Function_ {
		const maxInputs = aliasedNumber(params, "maxInputs", "max_inputs");
		const targetInputs = aliasedNumber(params, "targetInputs", "target_inputs");
		const diff: Partial<FunctionOptions> = {};
		if (maxInputs !== undefined) diff.maxConcurrentInputs = maxInputs;
		if (targetInputs !== undefined) diff.targetConcurrentInputs = targetInputs;
		return new Function_(
			this.#client,
			this.functionId,
			this.methodName,
			this.#handleMetadata,
			mergeServiceOptions(this.#options, diff),
		);
	}

	with_concurrency(params: FunctionWithConcurrencyParams): Function_ {
		return this.withConcurrency(params);
	}

	/**
	 * Returns a Function with dynamic batching enabled or overridden
	 * @param params - Batching parameters
	 * @returns Function with batching settings applied
	 */
	withBatching(params: FunctionWithBatchingParams): Function_ {
		const maxBatchSize = aliasedNumber(
			params,
			"maxBatchSize",
			"max_batch_size",
		);
		const waitMs = aliasedNumber(params, "waitMs", "wait_ms");
		const diff: Partial<FunctionOptions> = {};
		if (maxBatchSize !== undefined) diff.batchMaxSize = maxBatchSize;
		if (waitMs !== undefined) diff.batchWaitMs = waitMs;
		return new Function_(
			this.#client,
			this.functionId,
			this.methodName,
			this.#handleMetadata,
			mergeServiceOptions(this.#options, diff),
		);
	}

	with_batching(params: FunctionWithBatchingParams): Function_ {
		return this.withBatching(params);
	}

	/**
	 * Creates a Function instance with withOptions/withConcurrency/withBatching settings applied
	 * @returns Function with settings bound
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
	 * Executes the Function remotely and synchronously, returning the result
	 * @param args - Positional arguments
	 * @param kwargs - Keyword argument mapping
	 * @returns Function execution result
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
		// TODO(ryan): Add retry tests.
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
	 * Generator API compatibility. Yields each item when the result is iterable
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

	async *remoteGen(
		args: unknown[] = [],
		kwargs: Record<string, unknown> = {},
	): AsyncGenerator<unknown, void, unknown> {
		yield* this.remote_gen(args, kwargs);
	}

	/**
	 * Local execution compatibility. TS handles use the same path as remote
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
	 * Spawns the Function asynchronously and returns a FunctionCall
	 * @param args - Positional arguments
	 * @param kwargs - Keyword argument mapping
	 * @returns FunctionCall that tracks the asynchronous execution
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
	 * Passes each input to the Function and returns results as an array
	 * @param inputs - First positional argument for each call
	 */
	async map(inputs: Iterable<unknown>): Promise<unknown[]> {
		const calls = await Promise.all(
			Array.from(inputs, (input) => this.spawn([input])),
		);
		return await FunctionCall.gather(calls);
	}

	/**
	 * Passes each input tuple as Function positional arguments and returns results as an array
	 * @param inputs - Positional arguments for each call
	 */
	async starmap(inputs: Iterable<readonly unknown[]>): Promise<unknown[]> {
		const calls = await Promise.all(
			Array.from(inputs, (args) => this.spawn([...args])),
		);
		return await FunctionCall.gather(calls);
	}

	/**
	 * Passes each input to the Function and waits for completion, discarding results
	 * @param inputs - First positional argument for each call
	 */
	async forEach(inputs: Iterable<unknown>): Promise<void> {
		await this.map(inputs);
	}

	/**
	 * Python-compatible alias for {@link Function_#forEach}
	 */
	async for_each(inputs: Iterable<unknown>): Promise<void> {
		await this.forEach(inputs);
	}

	/**
	 * Gets current statistics for the Function
	 * @returns Statistics including backlog and runner count
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
	 * Updates autoscaler settings for the Function
	 * @param params - Autoscaler settings
	 */
	async updateAutoscaler(
		params: FunctionUpdateAutoscalerParams,
	): Promise<void> {
		const scaleupWindowMs = secondsAliasToMs(
			params,
			"scaleupWindowMs",
			"scaleup_window",
		);
		const scaledownWindowMs = secondsAliasToMs(
			params,
			"scaledownWindowMs",
			"scaledown_window",
		);

		await this.#client.cpClient.functionUpdateSchedulingParams({
			functionId: this.functionId,
			warmPoolSizeOverride: 0, // Deprecated field, always set to 0
			settings: {
				minContainers: aliasedNumber(params, "minContainers", "min_containers"),
				maxContainers: aliasedNumber(params, "maxContainers", "max_containers"),
				bufferContainers: aliasedNumber(
					params,
					"bufferContainers",
					"buffer_containers",
				),
				targetConcurrency: aliasedNumber(
					params,
					"targetConcurrency",
					"target_concurrency",
				),
				scaleupWindow:
					scaleupWindowMs !== undefined
						? Math.trunc(scaleupWindowMs / 1000)
						: undefined,
				scaledownWindow:
					scaledownWindowMs !== undefined
						? Math.trunc(scaledownWindowMs / 1000)
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
	 * URL for a Function running as a web endpoint
	 * @returns Web endpoint URL, or undefined when this is not a web endpoint
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
			// Fail early because the remote Function does not support CBOR input.
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
			// Omitted in the Python SDK; defaults to false.
			finalInput: false,
		};
	}
}

/**
 * Uploads a large payload to blob storage
 * @param cpClient - gRPC client
 * @param data - Binary data to upload
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
