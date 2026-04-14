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
	SchedulerPlacement,
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
import type { Proxy as ModalProxy } from "@/services/proxy/proxy";
import type { Secret } from "@/services/secret/secret";
import type { Volume } from "@/services/volume/volume";
import { checkForRenamedParams } from "@/utils/validation";
import type { Probe } from "./sandbox_probe";

/**
 * @description stdin は常に存在するが、stdout/stderr を不要なら無視できる。
 * デフォルトは "pipe" (Node.js の挙動に準拠)。
 * "ignore" に設定すると出力ストリームは空になる
 */
export type StdioBehavior = "pipe" | "ignore";

/**
 * @description Sandbox またはコンテナプロセスから読み取るデータの種類を指定する。
 * "text" は UTF-8 テキスト、"binary" は生バイト列 (Uint8Array) として読み取る
 */
export type StreamMode = "text" | "binary";

/**
 * @description Sandbox作成時のパラメータ
 * @property cpu - 物理CPUコアの予約数(小数可) @optional
 * @property cpuLimit - 物理CPUコアのハードリミット(小数可) @optional
 * @property memoryMiB - メモリ予約量 (MiB) @optional
 * @property memoryLimitMiB - メモリのハードリミット (MiB) @optional
 * @property gpu - GPU予約 (例: "A100", "T4:2", "A100-80GB:4") @optional
 * @property timeoutMs - Sandboxの最大生存時間(ミリ秒) @optional @defaultValue 300000
 * @property idleTimeoutMs - アイドル状態で終了するまでの時間(ミリ秒) @optional
 * @property workdir - 作業ディレクトリ @optional
 * @property command - メインプロセスのコマンド引数。未指定時は無期限スリープ @optional
 * @property env - 環境変数 @optional
 * @property secrets - 環境変数として注入する Secret の配列 @optional
 * @property volumes - Volume のマウントポイント @optional
 * @property cloudBucketMounts - CloudBucketMount のマウントポイント @optional
 * @property pty - PTY を有効にする @optional
 * @property encryptedPorts - TLS で暗号化されたトンネルポートの一覧 @optional
 * @property h2Ports - HTTP/2 で暗号化されたトンネルポートの一覧 @optional
 * @property unencryptedPorts - 暗号化なしのトンネルポートの一覧 @optional
 * @property blockNetwork - 全ネットワークアクセスをブロックする @optional
 * @property cidrAllowlist - アクセスを許可する CIDR の一覧。blockNetwork とは併用不可 @optional
 * @property cloud - 使用するクラウドプロバイダー @optional
 * @property regions - 実行するリージョン @optional
 * @property verbose - 詳細ログを有効にする @optional
 * @property proxy - Sandbox の前段に配置する Proxy @optional
 * @property name - Sandbox の名前(App 内で一意) @optional
 * @property experimentalOptions - 実験的オプション @optional
 * @property customDomain - カスタムドメイン(Enterprise 限定) @optional
 * @property readinessProbe - 接続受付可能かを判定する Probe @optional
 * @property includeOidcIdentityToken - OIDC ID トークンを含める @optional
 */
export type SandboxCreateParams = {
	cpu?: number;
	cpuLimit?: number;
	memoryMiB?: number;
	memoryLimitMiB?: number;
	gpu?: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	workdir?: string;
	command?: string[];
	env?: Record<string, string>;
	secrets?: Secret[];
	volumes?: Record<string, Volume>;
	cloudBucketMounts?: Record<string, CloudBucketMount>;
	pty?: boolean;
	encryptedPorts?: number[];
	h2Ports?: number[];
	unencryptedPorts?: number[];
	blockNetwork?: boolean;
	cidrAllowlist?: string[];
	cloud?: string;
	regions?: string[];
	verbose?: boolean;
	proxy?: ModalProxy;
	name?: string;
	experimentalOptions?: Record<string, unknown>;
	customDomain?: string;
	readinessProbe?: Probe;
	includeOidcIdentityToken?: boolean;
};

/**
 * @description client.sandboxes.list()のオプションパラメータ
 * @property appId - 特定の App で絞り込む @optional
 * @property tags - 指定したタグを全て含む Sandbox のみ返す @optional
 * @property environment - 環境名。未指定なら現在のプロファイルを使用 @optional
 */
export type SandboxListParams = {
	appId?: string;
	tags?: Record<string, string>;
	environment?: string;
};

/**
 * @description client.sandboxes.fromName()のオプションパラメータ
 * @property environment - 環境名 @optional
 */
export type SandboxFromNameParams = {
	environment?: string;
};

/**
 * @description Sandbox.exec()のオプションパラメータ
 * @property mode - 入出力ストリームのテキスト/バイナリエンコーディング @optional
 * @property stdout - 標準出力のパイプ/無視 @optional
 * @property stderr - 標準エラーのパイプ/無視 @optional
 * @property workdir - コマンド実行時の作業ディレクトリ @optional
 * @property timeoutMs - プロセスのタイムアウト(ミリ秒) @optional @defaultValue 0
 * @property env - コマンド実行時の環境変数 @optional
 * @property secrets - 環境変数として注入する Secret の配列 @optional
 * @property pty - PTY を有効にする @optional
 */
export type SandboxExecParams = {
	mode?: StreamMode;
	stdout?: StdioBehavior;
	stderr?: StdioBehavior;
	workdir?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
	secrets?: Secret[];
	pty?: boolean;
};

/**
 * @description Sandbox.terminate()のオプションパラメータ
 * @property wait - true なら Sandbox の終了を待ち exit code を返す @optional
 */
export type SandboxTerminateParams = {
	wait?: boolean;
};

/**
 * @description デフォルトのPTY設定を返す
 * @returns PTYInfoプロトメッセージ
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

// Linux の exec に渡せる引数の最大バイト数。
// サーバー側の制限だが変更される可能性は低い(getconf ARG_MAX で確認可能)。
//
// 本番環境での検証では制限は 131072 バイト (2**17)。
// 引数以外のコマンドラインオーバーヘッド('runsc exec ...' 等)を考慮し 2**16 を使用。
/**
 * @description execの引数がLinuxのARG_MAX制限を超えないか検証する
 * @param args - コマンド引数の配列
 * @throws InvalidError 引数の合計長がARG_MAXを超える場合
 */
export function validateExecArgs(args: string[]): void {
	const ARG_MAX_BYTES = 2 ** 16;

	// "[Errno 7] Argument list too long" エラーを防止
	const totalArgLen = args.reduce((sum, arg) => sum + arg.length, 0);
	if (totalArgLen > ARG_MAX_BYTES) {
		throw new InvalidError(
			`Total length of CMD arguments must be less than ${ARG_MAX_BYTES} bytes (ARG_MAX). ` +
				`Got ${totalArgLen} bytes.`,
		);
	}
}

/**
 * @description SandboxCreateParamsからgRPCリクエストを構築する
 * @param appId - アプリID
 * @param imageId - コンテナイメージID
 * @param params - Sandbox作成パラメータ
 * @returns SandboxCreateRequestプロトメッセージ
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

	// gRPC API は秒単位の整数値のみ受け付ける
	if (params.timeoutMs !== undefined && params.timeoutMs <= 0) {
		throw new Error(`timeoutMs must be positive, got ${params.timeoutMs}`);
	}
	if (params.timeoutMs && params.timeoutMs % 1000 !== 0) {
		throw new Error(
			`timeoutMs must be a multiple of 1000ms, got ${params.timeoutMs}`,
		);
	}
	if (params.idleTimeoutMs !== undefined && params.idleTimeoutMs <= 0) {
		throw new Error(
			`idleTimeoutMs must be positive, got ${params.idleTimeoutMs}`,
		);
	}
	if (params.idleTimeoutMs && params.idleTimeoutMs % 1000 !== 0) {
		throw new Error(
			`idleTimeoutMs must be a multiple of 1000ms, got ${params.idleTimeoutMs}`,
		);
	}

	if (params.workdir && !params.workdir.startsWith("/")) {
		throw new Error(`workdir must be an absolute path, got: ${params.workdir}`);
	}

	const volumeMounts: VolumeMount[] = params.volumes
		? Object.entries(params.volumes).map(([mountPath, volume]) => ({
				volumeId: volume.volumeId,
				mountPath,
				allowBackgroundCommits: true,
				readOnly: volume.isReadOnly,
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
	addPorts(params.encryptedPorts, false);
	addPorts(params.h2Ports, false, TunnelType.TUNNEL_TYPE_H2);
	addPorts(params.unencryptedPorts, true);

	const secretIds = (params.secrets || []).map((secret) => secret.secretId);

	let networkAccess: NetworkAccess;
	if (params.blockNetwork) {
		if (params.cidrAllowlist) {
			throw new Error(
				"cidrAllowlist cannot be used when blockNetwork is enabled",
			);
		}
		networkAccess = {
			networkAccessType: NetworkAccess_NetworkAccessType.BLOCKED,
			allowedCidrs: [],
		};
	} else if (params.cidrAllowlist) {
		networkAccess = {
			networkAccessType: NetworkAccess_NetworkAccessType.ALLOWLIST,
			allowedCidrs: params.cidrAllowlist,
		};
	} else {
		networkAccess = {
			networkAccessType: NetworkAccess_NetworkAccessType.OPEN,
			allowedCidrs: [],
		};
	}

	const schedulerPlacement: SchedulerPlacement | undefined = params.regions
		?.length
		? SchedulerPlacement.create({
				regions: params.regions,
			})
		: undefined;

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

	// 公開インターフェースは将来の拡張のため Record<string, any> だが、
	// 現在の proto は Record<string, boolean> のみサポートするためここで検証する
	const protoExperimentalOptions: Record<string, boolean> =
		params.experimentalOptions
			? Object.entries(params.experimentalOptions).reduce(
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
			imageId,
			timeoutSecs:
				params.timeoutMs !== undefined ? params.timeoutMs / 1000 : 300,
			...(params.idleTimeoutMs !== undefined && {
				idleTimeoutSecs: params.idleTimeoutMs / 1000,
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
			...(params.customDomain !== undefined && {
				customDomain: params.customDomain,
			}),
			...(params.readinessProbe !== undefined && {
				readinessProbe: ProbeProto.create(params.readinessProbe.toProto()),
			}),
			includeOidcIdentityToken: params.includeOidcIdentityToken ?? false,
		},
	});
}

/**
 * @description SandboxExecParamsからTaskExecStartRequestを構築する
 * @param taskId - タスクID
 * @param execId - 実行ID
 * @param command - 実行するコマンドと引数
 * @param params - execパラメータ
 * @returns TaskExecStartRequestプロトメッセージ
 */
export function buildTaskExecStartRequestProto(
	taskId: string,
	execId: string,
	command: string[],
	params?: SandboxExecParams,
): TaskExecStartRequest {
	checkForRenamedParams(params, { timeout: "timeoutMs" });

	if (params?.timeoutMs !== undefined && params.timeoutMs <= 0) {
		throw new Error(`timeoutMs must be positive, got ${params.timeoutMs}`);
	}
	if (params?.timeoutMs && params.timeoutMs % 1000 !== 0) {
		throw new Error(
			`timeoutMs must be a multiple of 1000ms, got ${params.timeoutMs}`,
		);
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
		timeoutSecs: params?.timeoutMs ? params.timeoutMs / 1000 : undefined,
		workdir: params?.workdir,
		secretIds,
		ptyInfo,
		runtimeDebug: false,
	});
}
