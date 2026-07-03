import { InvalidError } from "@/core/errors";
import {
	type CloudBucketMount as CloudBucketMountProto,
	type NetworkAccess,
	NetworkAccess_NetworkAccessType,
	PortSpec,
	PortSpecs,
	Probe as ProbeProto,
	PTYInfo,
	PTYInfo_PTYType,
	Resources,
	SandboxCreateRequest,
	SandboxCreateV2Request,
	SchedulerPlacement as SchedulerPlacementProto,
	type SharedVolumeMount,
	TunnelType,
	type VolumeMount,
} from "@/generated/modal_proto/api";
import {
	TaskExecStartRequest,
	TaskExecStderrConfig,
	TaskExecStdoutConfig,
} from "@/generated/modal_proto/task_command_router";
import type { CloudBucketMount } from "@/services/cloud_bucket_mount/cloud_bucket_mount";
import { parseGpuConfig } from "@/services/deploy/app";
import type { NetworkFileSystem } from "@/services/network_file_system/network_file_system";
import type { Proxy as ModalProxy } from "@/services/proxy/proxy";
import type { SchedulerPlacement } from "@/services/scheduler_placement/scheduler_placement";
import type { Secret } from "@/services/secret/secret";
import { type Volume, volumeToMountProto } from "@/services/volume/volume";
import {
	aliasedBoolean,
	aliasedValue,
	secondsAliasToMs,
} from "@/utils/param_aliases";
import { checkForRenamedParams } from "@/utils/validation";
import type { Probe } from "./sandbox_probe";

/**
 * stdin always exists, but stdout/stderr can be ignored when not needed.
 * The default is "pipe", matching Node.js behavior.
 * When set to "ignore", output streams are empty.
 */
export type StdioBehavior = "pipe" | "ignore";

/**
 * Specifies the kind of data read from a Sandbox or container process.
 * "text" reads UTF-8 text, and "binary" reads raw bytes as Uint8Array.
 */
export type StreamMode = "text" | "binary";

/**
 * Parameters for creating a Sandbox
 * @property cpu - Reserved physical CPU cores, fractional values allowed
 * @property cpuLimit - Hard limit for physical CPU cores, fractional values allowed
 * @property memoryMiB - Reserved memory in MiB
 * @property memoryLimitMiB - Hard memory limit in MiB
 * @property gpu - GPU reservation, for example "A100", "T4:2", or "A100-80GB:4"
 * @property timeoutMs - Maximum Sandbox lifetime in milliseconds @defaultValue 300000
 * @property idleTimeoutMs - Time in milliseconds before idle termination
 * @property workdir - Working directory
 * @property command - Main process command arguments. Sleeps forever when omitted
 * @property env - Environment variables
 * @property secrets - Secrets to inject as environment variables
 * @property volumes - Volume mount points
 * @property cloudBucketMounts - CloudBucketMount mount points
 * @property pty - Enable PTY
 * @property encryptedPorts - Tunnel ports encrypted with TLS
 * @property h2Ports - Tunnel ports encrypted with HTTP/2
 * @property unencryptedPorts - Unencrypted tunnel ports
 * @property blockNetwork - Block all network access
 * @property cidrAllowlist - CIDR allowlist. Cannot be used with blockNetwork
 * @property cloud - Cloud provider to use
 * @property regions - Regions to run in
 * @property schedulerPlacement - Scheduling constraints
 * @property verbose - Enable verbose logs
 * @property proxy - Proxy placed in front of the Sandbox
 * @property name - Sandbox name, unique within the App
 * @property experimentalOptions - Experimental options
 * @property customDomain - Custom domain, Enterprise only
 * @property readinessProbe - Probe that determines whether the Sandbox can accept connections
 * @property includeOidcIdentityToken - Include an OIDC ID token
 */
export type SandboxCreateParams = {
	cpu?: number;
	cpuLimit?: number;
	memoryMiB?: number;
	memoryLimitMiB?: number;
	gpu?: string;
	timeoutMs?: number;
	timeout?: number;
	idleTimeoutMs?: number;
	idle_timeout?: number;
	idle_timeout_ms?: number;
	workdir?: string;
	command?: string[];
	env?: Record<string, string>;
	secrets?: Secret[];
	mountIds?: string[];
	volumes?: Record<string, Volume>;
	networkFileSystems?: Record<string, NetworkFileSystem>;
	network_file_systems?: Record<string, NetworkFileSystem>;
	cloudBucketMounts?: Record<string, CloudBucketMount>;
	pty?: boolean;
	encryptedPorts?: number[];
	encrypted_ports?: number[];
	h2Ports?: number[];
	h2_ports?: number[];
	unencryptedPorts?: number[];
	unencrypted_ports?: number[];
	blockNetwork?: boolean;
	block_network?: boolean;
	cidrAllowlist?: string[];
	cidr_allowlist?: string[];
	outboundCidrAllowlist?: string[];
	outbound_cidr_allowlist?: string[];
	outboundDomainAllowlist?: string[];
	outbound_domain_allowlist?: string[];
	inboundCidrAllowlist?: string[];
	inbound_cidr_allowlist?: string[];
	cloud?: string;
	regions?: string[];
	schedulerPlacement?: SchedulerPlacement;
	verbose?: boolean;
	proxy?: ModalProxy;
	name?: string;
	tags?: Record<string, string>;
	experimentalOptions?: Record<string, unknown>;
	experimental_options?: Record<string, unknown>;
	customDomain?: string;
	custom_domain?: string;
	readinessProbe?: Probe;
	readiness_probe?: Probe;
	includeOidcIdentityToken?: boolean;
	include_oidc_identity_token?: boolean;
};

/**
 * Optional parameters for client.sandboxes.list()
 * @property appId - Filter by a specific App
 * @property tags - Return only Sandboxes containing all specified tags
 * @property environment - Environment name. Uses the current profile when omitted
 */
export type SandboxListParams = {
	appId?: string;
	tags?: Record<string, string>;
	environment?: string;
};

export type SandboxExperimentalListParams = {
	appId: string;
};

/**
 * Optional parameters for client.sandboxes.fromName()
 * @property environment - Environment name
 */
export type SandboxFromNameParams = {
	environment?: string;
};

/**
 * Optional parameters for Sandbox.exec()
 * @property mode - Text or binary encoding for input/output streams
 * @property stdout - Pipe or ignore stdout
 * @property stderr - Pipe or ignore stderr
 * @property workdir - Working directory for command execution
 * @property timeoutMs - Process timeout in milliseconds @defaultValue 0
 * @property env - Environment variables for command execution
 * @property secrets - Secrets to inject as environment variables
 * @property pty - Enable PTY
 */
export type SandboxExecParams = {
	mode?: StreamMode;
	stdout?: StdioBehavior;
	stderr?: StdioBehavior;
	workdir?: string;
	timeoutMs?: number;
	timeout?: number;
	env?: Record<string, string>;
	secrets?: Secret[];
	pty?: boolean;
};

/**
 * Optional parameters for Sandbox.terminate()
 * @property wait - When true, waits for Sandbox termination and returns the exit code
 */
export type SandboxTerminateParams = {
	wait?: boolean;
};

export type SandboxSnapshotFilesystemParams = {
	timeoutMs?: number;
	ttlMs?: number | null;
	experimentalEncryptionKey?: Uint8Array;
};

export type SandboxSnapshotDirectoryParams = {
	timeoutMs?: number;
	ttlMs?: number | null;
	experimentalEncryptionKey?: Uint8Array;
};

export type SandboxMountImageParams = {
	experimentalEncryptionKey?: Uint8Array;
};

export type SandboxUpdateNetworkPolicyParams = {
	outboundCidrAllowlist: string[];
	outboundDomainAllowlist: string[];
};

/**
 * Returns the default PTY settings
 * @returns PTYInfo proto message
 */
export function defaultSandboxPTYInfo(): PTYInfo {
	return PTYInfo.create({
		enabled: true,
		winszRows: 24,
		winszCols: 80,
		envTerm: "xterm-256color",
		envColorterm: "truecolor",
		envTermProgram: "",
		ptyType: PTYInfo_PTYType.PTY_TYPE_SHELL,
		noTerminateOnIdleStdin: true,
	});
}

// Maximum number of argument bytes that can be passed to Linux exec.
// This is a server-side limit, but is unlikely to change and can be checked with getconf ARG_MAX.
//
// Production validation shows a limit of 131072 bytes (2**17).
// Use 2**16 to account for command-line overhead outside the arguments, such as 'runsc exec ...'.
/**
 * Validates that exec arguments do not exceed the Linux ARG_MAX limit
 * @param args - Command arguments
 * @throws InvalidError when the total argument length exceeds ARG_MAX
 */
export function validateExecArgs(args: string[]): void {
	const ARG_MAX_BYTES = 2 ** 16;

	// Prevent "[Errno 7] Argument list too long" errors.
	const totalArgLen = args.reduce((sum, arg) => sum + arg.length, 0);
	if (totalArgLen > ARG_MAX_BYTES) {
		throw new InvalidError(
			`Total length of CMD arguments must be less than ${ARG_MAX_BYTES} bytes (ARG_MAX). ` +
				`Got ${totalArgLen} bytes.`,
		);
	}
}

/**
 * Builds a gRPC request from SandboxCreateParams
 * @param appId - App ID
 * @param imageId - Container image ID
 * @param params - Sandbox creation parameters
 * @returns SandboxCreateRequest proto message
 */
export async function buildSandboxCreateRequestProto(
	appId: string,
	imageId: string,
	params: SandboxCreateParams = {},
): Promise<SandboxCreateRequest> {
	checkForRenamedParams(params, {
		memory: "memoryMiB",
		memoryLimit: "memoryLimitMiB",
		timeout: "timeoutMs",
		idleTimeout: "idleTimeoutMs",
	});

	const gpuConfig = parseGpuConfig(params.gpu);
	const timeoutMs = secondsAliasToMs(params, "timeoutMs", "timeout");
	const idleTimeoutMs = secondsAliasToMs(
		params,
		"idleTimeoutMs",
		"idle_timeout",
	);
	const networkFileSystems = aliasedValue<Record<string, NetworkFileSystem>>(
		params,
		"networkFileSystems",
		"network_file_systems",
	);
	const encryptedPorts = aliasedValue<number[]>(
		params,
		"encryptedPorts",
		"encrypted_ports",
	);
	const h2Ports = aliasedValue<number[]>(params, "h2Ports", "h2_ports");
	const unencryptedPorts = aliasedValue<number[]>(
		params,
		"unencryptedPorts",
		"unencrypted_ports",
	);
	const blockNetwork =
		aliasedBoolean(params, "blockNetwork", "block_network") ?? false;
	const cidrAllowlist = aliasedValue<string[]>(
		params,
		"cidrAllowlist",
		"cidr_allowlist",
	);
	const outboundCidrAllowlist = aliasedValue<string[]>(
		params,
		"outboundCidrAllowlist",
		"outbound_cidr_allowlist",
	);
	const outboundDomainAllowlist = aliasedValue<string[]>(
		params,
		"outboundDomainAllowlist",
		"outbound_domain_allowlist",
	);
	const inboundCidrAllowlist =
		aliasedValue<string[]>(
			params,
			"inboundCidrAllowlist",
			"inbound_cidr_allowlist",
		) ?? [];
	const experimentalOptions = aliasedValue<Record<string, unknown>>(
		params,
		"experimentalOptions",
		"experimental_options",
	);
	const customDomain = aliasedValue<string>(
		params,
		"customDomain",
		"custom_domain",
	);
	const readinessProbe = aliasedValue<Probe>(
		params,
		"readinessProbe",
		"readiness_probe",
	);
	const includeOidcIdentityToken =
		aliasedBoolean(
			params,
			"includeOidcIdentityToken",
			"include_oidc_identity_token",
		) ?? false;

	// The gRPC API accepts only integer second values.
	if (timeoutMs !== undefined && timeoutMs <= 0) {
		throw new Error(`timeoutMs must be positive, got ${timeoutMs}`);
	}
	if (timeoutMs && timeoutMs % 1000 !== 0) {
		throw new Error(`timeoutMs must be a multiple of 1000ms, got ${timeoutMs}`);
	}
	if (idleTimeoutMs !== undefined && idleTimeoutMs <= 0) {
		throw new Error(`idleTimeoutMs must be positive, got ${idleTimeoutMs}`);
	}
	if (idleTimeoutMs && idleTimeoutMs % 1000 !== 0) {
		throw new Error(
			`idleTimeoutMs must be a multiple of 1000ms, got ${idleTimeoutMs}`,
		);
	}

	if (params.workdir && !params.workdir.startsWith("/")) {
		throw new Error(`workdir must be an absolute path, got: ${params.workdir}`);
	}

	const volumeMounts: VolumeMount[] = params.volumes
		? Object.entries(params.volumes).map(([mountPath, volume]) =>
				volumeToMountProto(mountPath, volume),
			)
		: [];

	const nfsMounts: SharedVolumeMount[] = networkFileSystems
		? Object.entries(networkFileSystems).map(([mountPath, nfs]) => ({
				mountPath,
				sharedVolumeId: nfs.networkFileSystemId,
				cloudProvider: 0,
			}))
		: [];

	const cloudBucketMounts: CloudBucketMountProto[] = params.cloudBucketMounts
		? Object.entries(params.cloudBucketMounts).map(([mountPath, mount]) =>
				mount.toProto(mountPath),
			)
		: [];

	const openPorts: PortSpec[] = [];
	const addPorts = (
		ports: number[] | undefined,
		unencrypted: boolean,
		tunnelType?: TunnelType,
	) => {
		if (!ports) return;
		for (const port of ports) {
			openPorts.push(
				PortSpec.create({
					port,
					unencrypted,
					...(tunnelType !== undefined && { tunnelType }),
				}),
			);
		}
	};
	addPorts(encryptedPorts, false);
	addPorts(h2Ports, false, TunnelType.TUNNEL_TYPE_H2);
	addPorts(unencryptedPorts, true);

	const secretIds = (params.secrets || []).map((secret) => secret.secretId);

	let networkAccess: NetworkAccess;
	if (blockNetwork) {
		if (cidrAllowlist || outboundCidrAllowlist) {
			throw new Error(
				cidrAllowlist
					? "cidrAllowlist cannot be used when blockNetwork is enabled"
					: "outboundCidrAllowlist cannot be used when blockNetwork is enabled",
			);
		}
		if (outboundDomainAllowlist) {
			throw new Error(
				"outboundDomainAllowlist cannot be used when blockNetwork is enabled",
			);
		}
		if (inboundCidrAllowlist.length > 0) {
			throw new Error(
				"inboundCidrAllowlist cannot be used when blockNetwork is enabled",
			);
		}
		networkAccess = {
			networkAccessType: NetworkAccess_NetworkAccessType.BLOCKED,
			allowedCidrs: [],
			allowedDomains: [],
		};
	} else if (
		cidrAllowlist ||
		outboundCidrAllowlist ||
		outboundDomainAllowlist
	) {
		networkAccess = {
			networkAccessType: NetworkAccess_NetworkAccessType.ALLOWLIST,
			allowedCidrs: outboundCidrAllowlist ?? cidrAllowlist ?? [],
			allowedDomains: outboundDomainAllowlist ?? [],
		};
	} else {
		networkAccess = {
			networkAccessType: NetworkAccess_NetworkAccessType.OPEN,
			allowedCidrs: [],
			allowedDomains: [],
		};
	}

	const schedulerPlacement =
		params.schedulerPlacement?.toProto() ??
		(params.regions?.length
			? SchedulerPlacementProto.create({
					regions: params.regions,
				})
			: undefined);

	let ptyInfo: PTYInfo | undefined;
	if (params.pty) {
		ptyInfo = defaultSandboxPTYInfo();
	}

	let milliCpu: number | undefined;
	let milliCpuMax: number | undefined;
	if (params.cpu === undefined && params.cpuLimit !== undefined) {
		throw new Error("must also specify cpu when cpuLimit is specified");
	}
	if (params.cpu !== undefined) {
		if (params.cpu <= 0) {
			throw new Error(`cpu (${params.cpu}) must be a positive number`);
		}
		milliCpu = Math.trunc(1000 * params.cpu);
		if (params.cpuLimit !== undefined) {
			if (params.cpuLimit < params.cpu) {
				throw new Error(
					`cpu (${params.cpu}) cannot be higher than cpuLimit (${params.cpuLimit})`,
				);
			}
			milliCpuMax = Math.trunc(1000 * params.cpuLimit);
		}
	}

	let memoryMb: number | undefined;
	let memoryMbMax: number | undefined;
	if (params.memoryMiB === undefined && params.memoryLimitMiB !== undefined) {
		throw new Error(
			"must also specify memoryMiB when memoryLimitMiB is specified",
		);
	}
	if (params.memoryMiB !== undefined) {
		if (params.memoryMiB <= 0) {
			throw new Error(
				`the memoryMiB request (${params.memoryMiB}) must be a positive number`,
			);
		}
		memoryMb = params.memoryMiB;
		if (params.memoryLimitMiB !== undefined) {
			if (params.memoryLimitMiB < params.memoryMiB) {
				throw new Error(
					`the memoryMiB request (${params.memoryMiB}) cannot be higher than memoryLimitMiB (${params.memoryLimitMiB})`,
				);
			}
			memoryMbMax = params.memoryLimitMiB;
		}
	}

	// The public interface is Record<string, any> for future extension,
	// but the current proto supports only Record<string, boolean>, so validate here.
	const protoExperimentalOptions: Record<string, boolean> = experimentalOptions
		? Object.entries(experimentalOptions).reduce(
				(acc, [name, value]) => {
					if (typeof value !== "boolean") {
						throw new Error(
							`experimental option '${name}' must be a boolean, got ${value}`,
						);
					}
					acc[name] = Boolean(value);
					return acc;
				},
				{} as Record<string, boolean>,
			)
		: {};

	return SandboxCreateRequest.create({
		appId,
		definition: {
			entrypointArgs: params.command ?? [],
			mountIds: params.mountIds ?? [],
			imageId,
			timeoutSecs: timeoutMs !== undefined ? timeoutMs / 1000 : 300,
			...(idleTimeoutMs !== undefined && {
				idleTimeoutSecs: idleTimeoutMs / 1000,
			}),
			...(params.workdir !== undefined && { workdir: params.workdir }),
			networkAccess,
			resources: Resources.create({
				...(milliCpu !== undefined && { milliCpu }),
				...(milliCpuMax !== undefined && { milliCpuMax }),
				...(memoryMb !== undefined && { memoryMb }),
				...(memoryMbMax !== undefined && { memoryMbMax }),
				gpuConfig,
			}),
			volumeMounts,
			nfsMounts,
			cloudBucketMounts,
			ptyInfo,
			secretIds,
			openPorts: PortSpecs.create({ ports: openPorts }),
			cloudProviderStr: params.cloud ?? "",
			schedulerPlacement,
			verbose: params.verbose ?? false,
			...(params.proxy?.proxyId !== undefined && {
				proxyId: params.proxy.proxyId,
			}),
			...(params.name !== undefined && { name: params.name }),
			experimentalOptions: protoExperimentalOptions,
			...(customDomain !== undefined && {
				customDomain,
			}),
			...(readinessProbe !== undefined && {
				readinessProbe: ProbeProto.create(readinessProbe.toProto()),
			}),
			includeOidcIdentityToken,
			inboundCidrAllowlist,
		},
	});
}

/**
 * Builds a V2 Sandbox creation request from SandboxCreateParams
 * @param appId - App ID
 * @param imageId - Container image ID
 * @param params - Sandbox creation parameters
 * @returns SandboxCreateV2Request proto message
 */
export async function buildSandboxCreateV2RequestProto(
	appId: string,
	imageId: string,
	params: SandboxCreateParams = {},
): Promise<SandboxCreateV2Request> {
	if (params.tags && Object.keys(params.tags).length > 0) {
		throw new Error("tags are not supported by experimentalCreate");
	}
	if (params.gpu) {
		throw new Error("GPUs are not supported by experimentalCreate");
	}
	if (aliasedValue<string>(params, "customDomain", "custom_domain")) {
		throw new Error("custom domains are not supported by experimentalCreate");
	}

	const req = await buildSandboxCreateRequestProto(appId, imageId, params);
	return SandboxCreateV2Request.create({
		appId: req.appId,
		definition: req.definition,
	});
}

/**
 * Builds a TaskExecStartRequest from SandboxExecParams
 * @param taskId - Task ID
 * @param execId - Exec ID
 * @param command - Command and arguments to run
 * @param params - Exec parameters
 * @returns TaskExecStartRequest proto message
 */
export function buildTaskExecStartRequestProto(
	taskId: string,
	execId: string,
	command: string[],
	params?: SandboxExecParams,
	containerId?: string,
): TaskExecStartRequest {
	const timeoutMs = secondsAliasToMs(params, "timeoutMs", "timeout");

	if (timeoutMs !== undefined && timeoutMs <= 0) {
		throw new Error(`timeoutMs must be positive, got ${timeoutMs}`);
	}
	if (timeoutMs && timeoutMs % 1000 !== 0) {
		throw new Error(`timeoutMs must be a multiple of 1000ms, got ${timeoutMs}`);
	}

	const secretIds = (params?.secrets || []).map((secret) => secret.secretId);

	const stdout = params?.stdout ?? "pipe";
	const stderr = params?.stderr ?? "pipe";

	let stdoutConfig: TaskExecStdoutConfig;
	if (stdout === "pipe") {
		stdoutConfig = TaskExecStdoutConfig.TASK_EXEC_STDOUT_CONFIG_PIPE;
	} else if (stdout === "ignore") {
		stdoutConfig = TaskExecStdoutConfig.TASK_EXEC_STDOUT_CONFIG_DEVNULL;
	} else {
		throw new Error(`Unsupported stdout behavior: ${stdout}`);
	}

	let stderrConfig: TaskExecStderrConfig;
	if (stderr === "pipe") {
		stderrConfig = TaskExecStderrConfig.TASK_EXEC_STDERR_CONFIG_PIPE;
	} else if (stderr === "ignore") {
		stderrConfig = TaskExecStderrConfig.TASK_EXEC_STDERR_CONFIG_DEVNULL;
	} else {
		throw new Error(`Unsupported stderr behavior: ${stderr}`);
	}

	let ptyInfo: PTYInfo | undefined;
	if (params?.pty) {
		ptyInfo = defaultSandboxPTYInfo();
	}

	return TaskExecStartRequest.create({
		taskId,
		execId,
		commandArgs: command,
		stdoutConfig,
		stderrConfig,
		timeoutSecs: timeoutMs ? timeoutMs / 1000 : undefined,
		workdir: params?.workdir,
		secretIds,
		ptyInfo,
		runtimeDebug: false,
		...(containerId !== undefined && { containerId }),
	});
}
