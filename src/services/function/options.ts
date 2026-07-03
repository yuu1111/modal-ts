import {
	ClassParameterSet,
	type ClassParameterSpec,
	type ClassParameterValue,
	FunctionOptions as FunctionOptionsProto,
	type FunctionRetryPolicy,
	ParameterType,
	type VolumeMount,
} from "@/generated/modal_proto/api";
import { parseGpuConfig } from "@/services/deploy/app";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import type { Secret } from "@/services/secret/secret";
import { type Volume, volumeToMountProto } from "@/services/volume/volume";
import { aliasedNumber, secondsAliasToMs } from "@/utils/param_aliases";
import { parseRetries, type Retries } from "@/utils/retries";
import { checkForRenamedParams } from "@/utils/validation";

export { secondsAliasToMs } from "@/utils/param_aliases";

/**
 * Runtime options shared by Functions and Cls methods.
 */
export type ServiceOptions = {
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
 * Merges a diff into base options.
 *
 * @param base - Base options
 * @param diff - Diff to merge
 * @returns Merged result, or undefined when empty
 */
export function mergeServiceOptions<T extends ServiceOptions>(
	base: T | undefined,
	diff: Partial<T>,
): T | undefined {
	const filteredDiff = Object.fromEntries(
		Object.entries(diff).filter(([, value]) => value !== undefined),
	) as Partial<T>;
	const merged = { ...(base ?? {}), ...filteredDiff } as T;
	return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * Normalizes aliases to canonical option names.
 *
 * @param options - Service options
 * @returns Options with canonical fields populated
 */
function normalizeServiceOptions<T extends ServiceOptions>(options: T): T {
	const normalized: T = {
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
 * Builds a gRPC FunctionOptions protobuf from shared service options.
 *
 * @param options - Function or Cls options
 * @returns FunctionOptions proto message, or undefined when options are empty
 */
export async function buildFunctionOptionsProto<T extends ServiceOptions>(
	options?: T,
): Promise<FunctionOptionsProto | undefined> {
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
 * Encodes a parameter set based on the parameter schema.
 *
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
	encoded.sort((a, b) => a.name.localeCompare(b.name));
	return ClassParameterSet.encode({ parameters: encoded }).finish();
}

/**
 * Encodes a single parameter according to its parameter spec.
 *
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
