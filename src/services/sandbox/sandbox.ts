import { setTimeout } from "node:timers/promises";
import { ClientError, Status } from "nice-grpc";
import { v4 as uuidv4 } from "uuid";
import {
	isRetryableGrpc,
	type ModalClient,
	type ModalGrpcClient,
} from "@/core/client";
import {
	ClientClosedError,
	InvalidError,
	rethrowAlreadyExists,
	rethrowInvalid,
	rethrowNotFound,
	SandboxTimeoutError,
	TimeoutError,
} from "@/core/errors";
import { TaskCommandRouterClientImpl } from "@/core/task_command_router_client";
import {
	type CloudBucketMount as CloudBucketMountProto,
	FileDescriptor,
	type GenericResult,
	GenericResult_GenericStatus,
	type NetworkAccess,
	NetworkAccess_NetworkAccessType,
	PortSpec,
	PortSpecs,
	Probe as ProbeProto,
	PTYInfo,
	PTYInfo_PTYType,
	Resources,
	SandboxCreateRequest,
	type SandboxTagsGetResponse,
	SchedulerPlacement,
	TunnelType,
	type VolumeMount,
} from "@/generated/modal_proto/api";
import {
	TaskExecStartRequest,
	TaskExecStderrConfig,
	TaskExecStdoutConfig,
	TaskMountDirectoryRequest,
	TaskSnapshotDirectoryRequest,
	TaskUnmountDirectoryRequest,
} from "@/generated/modal_proto/task_command_router";
import type { CloudBucketMount } from "@/services/cloud_bucket_mount/cloud_bucket_mount";
import type { App } from "@/services/deploy/app";
import { parseGpuConfig } from "@/services/deploy/app";
import { Image } from "@/services/image/image";
import type { Proxy } from "@/services/proxy/proxy";
import { mergeEnvIntoSecrets, type Secret } from "@/services/secret/secret";
import type { Volume } from "@/services/volume/volume";
import {
	encodeIfString,
	type ModalReadStream,
	type ModalWriteStream,
	streamConsumingIter,
	toModalReadStream,
	toModalWriteStream,
} from "@/utils/streams";
import { checkForRenamedParams } from "@/utils/validation";
import {
	runFilesystemExec,
	SandboxFile,
	type SandboxFileMode,
} from "./sandbox_filesystem";

// SandboxGetLogs リトライ時のバックオフ設定
const SB_LOGS_INITIAL_DELAY_MS = 10;
const SB_LOGS_DELAY_FACTOR = 2;
const SB_LOGS_MAX_RETRIES = 10;

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
 * @description Probe作成時のパラメータ
 * @property intervalMs - ヘルスチェック間隔(ミリ秒) @defaultValue 100
 */
export type ProbeParams = {
	intervalMs: number;
};

/**
 * @description Sandbox のreadiness判定に使うプローブ
 */
export class Probe {
	readonly #tcpPort?: number;
	readonly #execArgv?: string[];
	readonly #intervalMs: number;

	private constructor(params: {
		tcpPort?: number;
		execArgv?: string[];
		intervalMs: number;
	}) {
		const { tcpPort, execArgv, intervalMs } = params;
		if ((tcpPort === undefined) === (execArgv === undefined)) {
			throw new InvalidError(
				"Probe must be created with Probe.withTcp(...) or Probe.withExec(...)",
			);
		}
		if (tcpPort !== undefined) this.#tcpPort = tcpPort;
		if (execArgv !== undefined) this.#execArgv = execArgv;
		this.#intervalMs = intervalMs;
	}

	/**
	 * @description TCPポートへの接続でreadiness判定するProbeを作成
	 * @param port - チェック対象のポート番号 (1-65535)
	 * @param params - プローブパラメータ
	 */
	static withTcp(
		port: number,
		params: ProbeParams = { intervalMs: 100 },
	): Probe {
		if (!Number.isInteger(port)) {
			throw new InvalidError("Probe.withTcp() expects an integer `port`");
		}
		if (port <= 0 || port > 65535) {
			throw new InvalidError(
				`Probe.withTcp() expects \`port\` in [1, 65535], got ${port}`,
			);
		}
		Probe.#validateIntervalMs("Probe.withTcp", params.intervalMs);
		return new Probe({ tcpPort: port, intervalMs: params.intervalMs });
	}

	/**
	 * @description コマンド実行でreadiness判定するProbeを作成
	 * @param argv - 実行するコマンドと引数
	 * @param params - プローブパラメータ
	 */
	static withExec(
		argv: string[],
		params: ProbeParams = { intervalMs: 100 },
	): Probe {
		if (!Array.isArray(argv) || argv.length === 0) {
			throw new InvalidError("Probe.withExec() requires at least one argument");
		}
		if (!argv.every((arg) => typeof arg === "string")) {
			throw new InvalidError(
				"Probe.withExec() expects all arguments to be strings",
			);
		}
		Probe.#validateIntervalMs("Probe.withExec", params.intervalMs);
		return new Probe({ execArgv: [...argv], intervalMs: params.intervalMs });
	}

	/** @internal */
	toProto() {
		if (this.#tcpPort !== undefined) {
			return {
				tcpPort: this.#tcpPort,
				intervalMs: this.#intervalMs,
			};
		}
		if (this.#execArgv !== undefined) {
			return {
				execCommand: { argv: this.#execArgv },
				intervalMs: this.#intervalMs,
			};
		}
		throw new InvalidError(
			"Probe must be created with Probe.withTcp(...) or Probe.withExec(...)",
		);
	}

	static #validateIntervalMs(methodName: string, intervalMs: number) {
		if (!Number.isInteger(intervalMs)) {
			throw new InvalidError(
				`${methodName}() expects an integer \`intervalMs\``,
			);
		}
		if (intervalMs <= 0) {
			throw new InvalidError(
				`${methodName}() expects \`intervalMs\` > 0, got ${intervalMs}`,
			);
		}
	}
}

/**
 * @description Sandbox作成時のパラメータ
 */
export type SandboxCreateParams = {
	/**
	 * @description 物理CPUコアの予約数(小数可)
	 */
	cpu?: number;

	/**
	 * @description 物理CPUコアのハードリミット(小数可)
	 */
	cpuLimit?: number;

	/**
	 * @description メモリ予約量 (MiB)
	 */
	memoryMiB?: number;

	/**
	 * @description メモリのハードリミット (MiB)
	 */
	memoryLimitMiB?: number;

	/**
	 * @description GPU予約 (例: "A100", "T4:2", "A100-80GB:4")
	 */
	gpu?: string;

	/**
	 * @description Sandboxの最大生存時間(ミリ秒) @defaultValue 300000
	 */
	timeoutMs?: number;

	/**
	 * @description アイドル状態で終了するまでの時間(ミリ秒)
	 */
	idleTimeoutMs?: number;

	/**
	 * @description 作業ディレクトリ
	 */
	workdir?: string;

	/**
	 * @description メインプロセスのコマンド引数。
	 * 未指定時はタイムアウトまたは終了まで無期限スリープ
	 */
	command?: string[];

	/**
	 * @description 環境変数
	 */
	env?: Record<string, string>;

	/**
	 * @description 環境変数として注入する {@link Secret} の配列
	 */
	secrets?: Secret[];

	/**
	 * @description {@link Volume} のマウントポイント
	 */
	volumes?: Record<string, Volume>;

	/**
	 * @description {@link CloudBucketMount} のマウントポイント
	 */
	cloudBucketMounts?: Record<string, CloudBucketMount>;

	/**
	 * @description PTY を有効にする
	 */
	pty?: boolean;

	/**
	 * @description TLS で暗号化されたトンネルポートの一覧
	 */
	encryptedPorts?: number[];

	/**
	 * @description HTTP/2 で暗号化されたトンネルポートの一覧
	 */
	h2Ports?: number[];

	/**
	 * @description 暗号化なしのトンネルポートの一覧
	 */
	unencryptedPorts?: number[];

	/**
	 * @description 全ネットワークアクセスをブロックする
	 */
	blockNetwork?: boolean;

	/**
	 * @description アクセスを許可する CIDR の一覧。未指定なら全 CIDR 許可。blockNetwork とは併用不可
	 */
	cidrAllowlist?: string[];

	/**
	 * @description 使用するクラウドプロバイダー
	 */
	cloud?: string;

	/**
	 * @description 実行するリージョン
	 */
	regions?: string[];

	/**
	 * @description 詳細ログを有効にする
	 */
	verbose?: boolean;

	/**
	 * @description Sandbox の前段に配置する {@link Proxy}
	 */
	proxy?: Proxy;

	/**
	 * @description Sandbox の名前(App 内で一意)
	 */
	name?: string;

	/**
	 * @description 実験的オプション
	 */
	experimentalOptions?: Record<string, unknown>;

	/**
	 * @description 接続先をデフォルトの代わりにこのドメインのサブドメインにする。
	 * Modal による事前設定が必要(Enterprise 限定)
	 */
	customDomain?: string;

	/**
	 * @description 接続受付可能かを判定する {@link Probe}
	 */
	readinessProbe?: Probe;

	/**
	 * @description Sandbox 環境に OIDC ID トークンを含める
	 */
	includeOidcIdentityToken?: boolean;
};

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
 * @description {@link Sandbox} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const sb = await modal.sandboxes.create(app, image);
 * ```
 */
export class SandboxService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 指定したAppとImageで新しいSandboxを作成する
	 * @param app - Appインスタンス
	 * @param image - コンテナイメージ
	 * @param params - Sandbox作成パラメータ
	 * @returns 作成されたSandbox
	 */
	async create(
		app: App,
		image: Image,
		params: SandboxCreateParams = {},
	): Promise<Sandbox> {
		await image.build(app);

		const mergedSecrets = await mergeEnvIntoSecrets(
			this.#client,
			params.env,
			params.secrets,
		);
		const { env: _env, ...restParams } = params;
		const mergedParams = {
			...restParams,
			secrets: mergedSecrets,
		};

		const createReq = await buildSandboxCreateRequestProto(
			app.appId,
			image.imageId,
			mergedParams,
		);
		const createResp = await this.#client.cpClient
			.sandboxCreate(createReq)
			.catch(rethrowAlreadyExists);

		this.#client.logger.debug(
			"Created Sandbox",
			"sandbox_id",
			createResp.sandboxId,
		);
		return new Sandbox(this.#client, createResp.sandboxId);
	}

	/**
	 * @description IDから実行中のSandboxを取得する
	 * @param sandboxId - Sandbox ID
	 * @returns Sandboxインスタンス
	 * @throws NotFoundError 指定されたSandboxが存在しない場合
	 */
	async fromId(sandboxId: string): Promise<Sandbox> {
		try {
			await this.#client.cpClient.sandboxWait({
				sandboxId,
				timeout: 0,
			});
		} catch (err) {
			rethrowNotFound(err, `Sandbox with id: '${sandboxId}' not found`);
		}

		return new Sandbox(this.#client, sandboxId);
	}

	/**
	 * @description デプロイ済みApp内の名前付きSandboxを取得する
	 * @param appName - アプリ名
	 * @param name - Sandbox名
	 * @param params - オプションパラメータ
	 * @returns Sandboxインスタンス
	 * @throws NotFoundError 指定されたSandboxが存在しない場合
	 */
	async fromName(
		appName: string,
		name: string,
		params?: SandboxFromNameParams,
	): Promise<Sandbox> {
		try {
			const resp = await this.#client.cpClient.sandboxGetFromName({
				sandboxName: name,
				appName,
				environmentName: this.#client.environmentName(params?.environment),
			});
			return new Sandbox(this.#client, resp.sandboxId);
		} catch (err) {
			rethrowNotFound(
				err,
				`Sandbox with name '${name}' not found in App '${appName}'`,
			);
		}
	}

	/**
	 * @description 現在の環境またはApp IDのSandbox一覧を返す
	 * @param params - フィルタリングパラメータ
	 */
	async *list(
		params: SandboxListParams = {},
	): AsyncGenerator<Sandbox, void, unknown> {
		const env = this.#client.environmentName(params.environment);
		const tagsList = params.tags
			? Object.entries(params.tags).map(([tagName, tagValue]) => ({
					tagName,
					tagValue,
				}))
			: [];

		let beforeTimestamp: number | undefined;
		while (true) {
			try {
				const resp = await this.#client.cpClient.sandboxList({
					...(params.appId !== undefined && { appId: params.appId }),
					...(beforeTimestamp !== undefined && { beforeTimestamp }),
					environmentName: env,
					includeFinished: false,
					tags: tagsList,
				});
				if (!resp.sandboxes || resp.sandboxes.length === 0) {
					return;
				}
				for (const info of resp.sandboxes) {
					yield new Sandbox(this.#client, info.id);
				}
				beforeTimestamp = resp.sandboxes[resp.sandboxes.length - 1]?.createdAt;
			} catch (err) {
				rethrowInvalid(err);
			}
		}
	}
}

/**
 * @description client.sandboxes.list()のオプションパラメータ
 */
export type SandboxListParams = {
	/**
	 * @description 特定の {@link App} で絞り込む
	 */
	appId?: string;
	/**
	 * @description 指定したタグを全て含む Sandbox のみ返す
	 */
	tags?: Record<string, string>;
	/**
	 * @description リクエストの環境名。未指定なら現在のプロファイルを使用
	 */
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
 */
export type SandboxExecParams = {
	/**
	 * @description 入出力ストリームのテキスト/バイナリエンコーディング
	 */
	mode?: StreamMode;
	/**
	 * @description 標準出力のパイプ/無視
	 */
	stdout?: StdioBehavior;
	/**
	 * @description 標準エラーのパイプ/無視
	 */
	stderr?: StdioBehavior;
	/**
	 * @description コマンド実行時の作業ディレクトリ
	 */
	workdir?: string;
	/**
	 * @description プロセスのタイムアウト(ミリ秒) @defaultValue 0 (タイムアウトなし)
	 */
	timeoutMs?: number;
	/**
	 * @description コマンド実行時の環境変数
	 */
	env?: Record<string, string>;
	/**
	 * @description 環境変数として注入する {@link Secret} の配列
	 */
	secrets?: Secret[];
	/**
	 * @description PTY を有効にする
	 */
	pty?: boolean;
};

/**
 * @description Sandbox.terminate()のオプションパラメータ
 */
export type SandboxTerminateParams = {
	/**
	 * @description true なら Sandbox の終了を待ち exit code を返す
	 */
	wait?: boolean;
};

/**
 * @description Sandbox.createConnectToken()のオプションパラメータ
 */
export type SandboxCreateConnectTokenParams = {
	/**
	 * @description プロキシが Sandbox へリクエスト転送時にヘッダーに追加するユーザー定義メタデータ
	 */
	userMetadata?: string;
};

/**
 * @description Sandbox.createConnectToken()が返す接続情報
 * @property url - 接続先URL
 * @property token - 認証トークン
 */
export type SandboxCreateConnectCredentials = {
	url: string;
	token: string;
};

/**
 * @description 実行中の {@link Sandbox} からフォワードされたポート
 */
export class Tunnel {
	/** @internal */
	constructor(
		public host: string,
		public port: number,
		public unencryptedHost?: string,
		public unencryptedPort?: number,
	) {}

	/**
	 * @description フォワードされたポートの公開 HTTPS URL を取得する
	 */
	get url(): string {
		let value = `https://${this.host}`;
		if (this.port !== 443) {
			value += `:${this.port}`;
		}
		return value;
	}

	/**
	 * @description 公開 TLS ソケットを [host, port] タプルで取得する
	 */
	get tlsSocket(): [string, number] {
		return [this.host, this.port];
	}

	/**
	 * @description 公開 TCP ソケットを [host, port] タプルで取得する
	 */
	get tcpSocket(): [string, number] {
		if (!this.unencryptedHost || this.unencryptedPort === undefined) {
			throw new InvalidError(
				"This tunnel is not configured for unencrypted TCP.",
			);
		}
		return [this.unencryptedHost, this.unencryptedPort];
	}
}

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

/**
 * @description 数秒で起動するModal上のセキュアで隔離されたコンテナ
 */
export class Sandbox {
	readonly #client: ModalClient;
	readonly sandboxId: string;
	#stdin?: ModalWriteStream<string>;
	#stdout?: ModalReadStream<string>;
	#stderr?: ModalReadStream<string>;
	#stdoutAbort?: AbortController;
	#stderrAbort?: AbortController;

	#taskId: string | undefined;
	#tunnels: Record<number, Tunnel> | undefined;
	#commandRouterClient: TaskCommandRouterClientImpl | undefined;
	#commandRouterClientPromise: Promise<TaskCommandRouterClientImpl> | undefined;
	#attached: boolean = true;

	/** @internal */
	constructor(client: ModalClient, sandboxId: string) {
		this.#client = client;
		this.sandboxId = sandboxId;
	}

	/**
	 * @description Sandboxの標準入力ストリーム
	 */
	get stdin(): ModalWriteStream<string> {
		if (!this.#stdin) {
			this.#stdin = toModalWriteStream(
				inputStreamSb(this.#client.cpClient, this.sandboxId),
			);
		}
		return this.#stdin;
	}

	/**
	 * @description Sandboxの標準出力ストリーム
	 */
	get stdout(): ModalReadStream<string> {
		if (!this.#stdout) {
			this.#stdoutAbort = new AbortController();
			const bytesStream = streamConsumingIter(
				outputStreamSb(
					this.#client.cpClient,
					this.sandboxId,
					FileDescriptor.FILE_DESCRIPTOR_STDOUT,
					this.#stdoutAbort.signal,
				),
				() => this.#stdoutAbort?.abort(),
			);
			this.#stdout = toModalReadStream(
				bytesStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			);
		}
		return this.#stdout;
	}

	/**
	 * @description Sandboxの標準エラー出力ストリーム
	 */
	get stderr(): ModalReadStream<string> {
		if (!this.#stderr) {
			this.#stderrAbort = new AbortController();
			const bytesStream = streamConsumingIter(
				outputStreamSb(
					this.#client.cpClient,
					this.sandboxId,
					FileDescriptor.FILE_DESCRIPTOR_STDERR,
					this.#stderrAbort.signal,
				),
				() => this.#stderrAbort?.abort(),
			);
			this.#stderr = toModalReadStream(
				bytesStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			);
		}
		return this.#stderr;
	}

	/**
	 * @description Sandboxにタグ(キーバリューペア)を設定する
	 * @param tags - タグのキーバリューマッピング
	 */
	async setTags(tags: Record<string, string>): Promise<void> {
		this.#ensureAttached();
		const tagsList = Object.entries(tags).map(([tagName, tagValue]) => ({
			tagName,
			tagValue,
		}));
		try {
			await this.#client.cpClient.sandboxTagsSet({
				environmentName: this.#client.environmentName(),
				sandboxId: this.sandboxId,
				tags: tagsList,
			});
		} catch (err) {
			rethrowInvalid(err);
		}
	}

	/**
	 * @description Sandboxに設定されているタグを取得する
	 * @returns タグのキーバリューマッピング
	 */
	async getTags(): Promise<Record<string, string>> {
		this.#ensureAttached();
		let resp: SandboxTagsGetResponse;
		try {
			resp = await this.#client.cpClient.sandboxTagsGet({
				sandboxId: this.sandboxId,
			});
		} catch (err) {
			rethrowInvalid(err);
		}

		const tags: Record<string, string> = {};
		for (const tag of resp.tags) {
			tags[tag.tagName] = tag.tagValue;
		}
		return tags;
	}

	/**
	 * @description Sandbox ファイルシステム内のファイルを開く
	 * @param path - 開くファイルのパス
	 * @param mode - ファイルオープンモード (r, w, a, r+, w+, a+)
	 * @returns {@link SandboxFile}
	 */
	async open(path: string, mode: SandboxFileMode = "r"): Promise<SandboxFile> {
		this.#ensureAttached();
		const taskId = await this.#getTaskId();
		const resp = await runFilesystemExec(this.#client.cpClient, {
			fileOpenRequest: {
				path,
				mode,
			},
			taskId,
		});
		// Open リクエストでは file descriptor は必ず設定される
		const fileDescriptor = resp.response.fileDescriptor as string;
		return new SandboxFile(this.#client, fileDescriptor, taskId);
	}

	async exec(
		command: string[],
		params?: SandboxExecParams & { mode?: "text" },
	): Promise<ContainerProcess<string>>;

	async exec(
		command: string[],
		params: SandboxExecParams & { mode: "binary" },
	): Promise<ContainerProcess<Uint8Array>>;

	async exec(
		command: string[],
		params?: SandboxExecParams,
	): Promise<ContainerProcess> {
		this.#ensureAttached();
		validateExecArgs(command);
		const taskId = await this.#getTaskId();

		const mergedSecrets = await mergeEnvIntoSecrets(
			this.#client,
			params?.env,
			params?.secrets,
		);
		const { env: _env, ...restExecParams } = params ?? {};
		const mergedParams: SandboxExecParams = {
			...restExecParams,
			secrets: mergedSecrets,
		};

		const commandRouterClient =
			await this.#getOrCreateCommandRouterClient(taskId);

		const execId = uuidv4();
		const request = buildTaskExecStartRequestProto(
			taskId,
			execId,
			command,
			mergedParams,
		);

		await commandRouterClient.execStart(request);

		this.#client.logger.debug(
			"Created ContainerProcess",
			"exec_id",
			execId,
			"sandbox_id",
			this.sandboxId,
			"command",
			command,
		);

		const deadline = mergedParams.timeoutMs
			? Date.now() + mergedParams.timeoutMs
			: null;

		return new ContainerProcess(
			taskId,
			execId,
			commandRouterClient,
			mergedParams,
			deadline,
		);
	}

	#ensureAttached(): void {
		if (!this.#attached) {
			throw new ClientClosedError();
		}
	}

	static readonly #maxGetTaskIdAttempts = 600; // 5 minutes at 500ms intervals

	async #getTaskId(): Promise<string> {
		if (this.#taskId !== undefined) {
			return this.#taskId;
		}
		for (let i = 0; i < Sandbox.#maxGetTaskIdAttempts; i++) {
			const resp = await this.#client.cpClient.sandboxGetTaskId({
				sandboxId: this.sandboxId,
			});
			if (resp.taskResult) {
				if (
					resp.taskResult.status ===
						GenericResult_GenericStatus.GENERIC_STATUS_SUCCESS ||
					!resp.taskResult.exception
				) {
					throw new Error(`Sandbox ${this.sandboxId} has already completed`);
				}
				throw new Error(
					`Sandbox ${this.sandboxId} has already completed with result: exception:"${resp.taskResult.exception}"`,
				);
			}
			if (resp.taskId) {
				this.#taskId = resp.taskId;
				return this.#taskId;
			}
			await setTimeout(500);
		}
		throw new Error(
			`Timed out waiting for task ID for Sandbox ${this.sandboxId}`,
		);
	}

	async #getOrCreateCommandRouterClient(
		taskId: string,
	): Promise<TaskCommandRouterClientImpl> {
		if (this.#commandRouterClient !== undefined) {
			return this.#commandRouterClient;
		}

		if (this.#commandRouterClientPromise !== undefined) {
			return this.#commandRouterClientPromise;
		}

		const promise = (async () => {
			const client = await TaskCommandRouterClientImpl.tryInit(
				this.#client.cpClient,
				taskId,
				this.#client.logger,
				this.#client.profile,
			);
			if (!client) {
				throw new Error(
					"Command router access is not available for this sandbox",
				);
			}
			if (!this.#attached) {
				client.close();
				throw new ClientClosedError();
			}
			this.#commandRouterClient = client;
			return client;
		})();
		this.#commandRouterClientPromise = promise;

		try {
			return await promise;
		} catch (err) {
			// 後続の呼び出しでリトライできるよう Promise をクリア
			if (this.#commandRouterClientPromise === promise) {
				this.#commandRouterClientPromise = undefined;
			}
			throw err;
		}
	}

	/**
	 * @description Sandbox への HTTP 接続用トークンを作成する
	 */
	async createConnectToken(
		params?: SandboxCreateConnectTokenParams,
	): Promise<SandboxCreateConnectCredentials> {
		this.#ensureAttached();
		const resp = await this.#client.cpClient.sandboxCreateConnectToken({
			sandboxId: this.sandboxId,
			...(params?.userMetadata !== undefined && {
				userMetadata: params.userMetadata,
			}),
		});
		return { url: resp.url, token: resp.token };
	}

	/**
	 * @description readinessプローブが成功するまでブロック
	 * @param timeoutMs - 最大待機時間(ミリ秒) @default 300000
	 */
	async waitUntilReady(timeoutMs = 300_000): Promise<void> {
		this.#ensureAttached();
		if (timeoutMs <= 0) {
			throw new InvalidError(`timeoutMs must be positive, got ${timeoutMs}`);
		}

		const deadline = Date.now() + timeoutMs;
		while (true) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw new TimeoutError("Sandbox operation timed out");
			}
			const requestTimeoutMs = Math.min(remainingMs, 50_000);
			try {
				const resp = await this.#client.cpClient.sandboxWaitUntilReady({
					sandboxId: this.sandboxId,
					timeout: requestTimeoutMs / 1000,
				});
				if (resp.readyAt && resp.readyAt > 0) {
					return;
				}
			} catch (err) {
				if (err instanceof ClientError && err.code === Status.DEADLINE_EXCEEDED)
					continue;
				throw err;
			}
		}
	}

	/**
	 * @description Sandboxを終了する
	 * @param params - オプションパラメータ(waitでexit codeを返す)
	 * @returns wait: trueの場合はexit code
	 */
	async terminate(): Promise<undefined>;
	async terminate(params: { wait: true }): Promise<number>;
	async terminate(
		params?: SandboxTerminateParams,
	): Promise<number | undefined> {
		this.#ensureAttached();
		await this.#client.cpClient.sandboxTerminate({ sandboxId: this.sandboxId });

		let exitCode: number | undefined;
		if (params?.wait) {
			exitCode = await this.wait();
		}

		this.#taskId = undefined;
		this.detach();
		return exitCode;
	}

	/**
	 * @description Sandboxとの接続を切断しローカルリソースを解放する(Sandbox自体はModal上で継続動作)
	 */
	detach(): void {
		this.#commandRouterClient?.close();
		this.#attached = false;
		this.#commandRouterClient = undefined;
		this.#commandRouterClientPromise = undefined;
		this.#tunnels = undefined;
	}

	/**
	 * @description Sandboxの終了を待機してexit codeを返す
	 * @returns exit code
	 */
	async wait(): Promise<number> {
		while (true) {
			const resp = await this.#client.cpClient.sandboxWait({
				sandboxId: this.sandboxId,
				timeout: 10,
			});
			if (resp.result) {
				const returnCode = Sandbox.#getReturnCode(resp.result);
				if (returnCode == null)
					throw new Error("Sandbox result missing return code");
				this.#client.logger.debug(
					"Sandbox wait completed",
					"sandbox_id",
					this.sandboxId,
					"status",
					resp.result.status,
					"return_code",
					returnCode,
				);
				return returnCode;
			}
		}
	}

	/**
	 * @description SandboxのTunnelメタデータを取得する
	 * @param timeoutMs - タイムアウト(ミリ秒) @default 50000
	 * @returns コンテナポートをキーとしたTunnelのマッピング
	 * @throws SandboxTimeoutError タイムアウト時
	 */
	async tunnels(timeoutMs = 50000): Promise<Record<number, Tunnel>> {
		this.#ensureAttached();
		if (this.#tunnels) {
			return this.#tunnels;
		}

		const resp = await this.#client.cpClient.sandboxGetTunnels({
			sandboxId: this.sandboxId,
			timeout: timeoutMs / 1000,
		});

		if (
			resp.result?.status === GenericResult_GenericStatus.GENERIC_STATUS_TIMEOUT
		) {
			throw new SandboxTimeoutError();
		}

		this.#tunnels = {};
		for (const t of resp.tunnels) {
			this.#tunnels[t.containerPort] = new Tunnel(
				t.host,
				t.port,
				t.unencryptedHost,
				t.unencryptedPort,
			);
		}

		return this.#tunnels;
	}

	/**
	 * @description Sandbox のファイルシステムをスナップショットする。
	 * 返された {@link Image} で同じファイルシステムの新しい Sandbox を起動できる
	 * @param timeoutMs - スナップショット操作のタイムアウト(ミリ秒)
	 * @returns {@link Image}
	 */
	async snapshotFilesystem(timeoutMs = 55000): Promise<Image> {
		this.#ensureAttached();
		const resp = await this.#client.cpClient.sandboxSnapshotFs({
			sandboxId: this.sandboxId,
			timeout: timeoutMs / 1000,
		});

		if (
			resp.result?.status !== GenericResult_GenericStatus.GENERIC_STATUS_SUCCESS
		) {
			throw new Error(
				`Sandbox snapshot failed: ${resp.result?.exception || "Unknown error"}`,
			);
		}

		if (!resp.imageId) {
			throw new Error("Sandbox snapshot response missing `imageId`");
		}

		return new Image(this.#client, resp.imageId, "");
	}

	/**
	 * @description Sandbox ファイルシステムのパスに {@link Image} をマウントする
	 * @param path - マウント先のパス
	 * @param image - マウントする {@link Image}。未指定なら空ディレクトリをマウント
	 */
	async mountImage(path: string, image?: Image): Promise<void> {
		this.#ensureAttached();
		const taskId = await this.#getTaskId();
		const commandRouterClient =
			await this.#getOrCreateCommandRouterClient(taskId);

		if (image && !image.imageId) {
			throw new Error(
				"Image must be built before mounting. Call `image.build(app)` first.",
			);
		}

		const pathBytes = encodeIfString(path);
		const imageId = image?.imageId ?? "";
		const request = TaskMountDirectoryRequest.create({
			taskId,
			path: pathBytes,
			imageId,
		});
		await commandRouterClient.mountDirectory(request);
	}

	/**
	 * @description Sandbox ファイルシステムのパスにマウントされた Image をアンマウントする
	 * @param path - マウントされていたパス
	 */
	async unmountImage(path: string): Promise<void> {
		this.#ensureAttached();
		const taskId = await this.#getTaskId();
		const commandRouterClient =
			await this.#getOrCreateCommandRouterClient(taskId);

		const pathBytes = encodeIfString(path);
		const request = TaskUnmountDirectoryRequest.create({
			taskId,
			path: pathBytes,
		});
		await commandRouterClient.unmountDirectory(request);
	}

	/**
	 * @description 実行中の Sandbox 内のディレクトリをスナップショットし新しい {@link Image} を作成する
	 * @param path - スナップショット対象のディレクトリパス
	 * @returns {@link Image}
	 */
	async snapshotDirectory(path: string): Promise<Image> {
		this.#ensureAttached();
		const taskId = await this.#getTaskId();
		const commandRouterClient =
			await this.#getOrCreateCommandRouterClient(taskId);

		const pathBytes = encodeIfString(path);
		const request = TaskSnapshotDirectoryRequest.create({
			taskId,
			path: pathBytes,
		});
		const response = await commandRouterClient.snapshotDirectory(request);

		if (!response.imageId) {
			throw new Error("Sandbox snapshot directory response missing `imageId`");
		}

		return new Image(this.#client, response.imageId, "");
	}

	/**
	 * @description Sandbox が終了したかを確認する。
	 * 実行中なら `null`、終了済みなら exit code を返す
	 */
	async poll(): Promise<number | null> {
		this.#ensureAttached();
		const resp = await this.#client.cpClient.sandboxWait({
			sandboxId: this.sandboxId,
			timeout: 0,
		});

		return Sandbox.#getReturnCode(resp.result);
	}

	static #getReturnCode(result: GenericResult | undefined): number | null {
		if (
			result === undefined ||
			result.status === GenericResult_GenericStatus.GENERIC_STATUS_UNSPECIFIED
		) {
			return null;
		}

		// subprocess API に合わせてステータスを exit code に変換
		if (result.status === GenericResult_GenericStatus.GENERIC_STATUS_TIMEOUT) {
			return 124;
		} else if (
			result.status === GenericResult_GenericStatus.GENERIC_STATUS_TERMINATED
		) {
			return 137;
		} else {
			return result.exitcode;
		}
	}
}

/**
 * @description Sandbox内で実行されるプロセスを表し、stdin/stdout/stderrストリームを提供する
 */
export class ContainerProcess<
	R extends string | Uint8Array = string | Uint8Array,
> {
	stdin: ModalWriteStream<R>;
	stdout: ModalReadStream<R>;
	stderr: ModalReadStream<R>;

	readonly #taskId: string;
	readonly #execId: string;
	readonly #commandRouterClient: TaskCommandRouterClientImpl;
	readonly #deadline: number | null;

	/** @internal */
	constructor(
		taskId: string,
		execId: string,
		commandRouterClient: TaskCommandRouterClientImpl,
		params?: SandboxExecParams,
		deadline?: number | null,
	) {
		this.#taskId = taskId;
		this.#execId = execId;
		this.#commandRouterClient = commandRouterClient;
		this.#deadline = deadline ?? null;

		const mode = params?.mode ?? "text";
		const stdout = params?.stdout ?? "pipe";
		const stderr = params?.stderr ?? "pipe";

		this.stdin = toModalWriteStream(
			inputStreamCp<R>(commandRouterClient, taskId, execId),
		);

		const stdoutStream =
			stdout === "ignore"
				? ReadableStream.from([])
				: streamConsumingIter(
						outputStreamCp(
							commandRouterClient,
							taskId,
							execId,
							FileDescriptor.FILE_DESCRIPTOR_STDOUT,
							this.#deadline,
						),
					);

		const stderrStream =
			stderr === "ignore"
				? ReadableStream.from([])
				: streamConsumingIter(
						outputStreamCp(
							commandRouterClient,
							taskId,
							execId,
							FileDescriptor.FILE_DESCRIPTOR_STDERR,
							this.#deadline,
						),
					);

		if (mode === "text") {
			this.stdout = toModalReadStream(
				stdoutStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			) as ModalReadStream<R>;
			this.stderr = toModalReadStream(
				stderrStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			) as ModalReadStream<R>;
		} else {
			this.stdout = toModalReadStream(stdoutStream) as ModalReadStream<R>;
			this.stderr = toModalReadStream(stderrStream) as ModalReadStream<R>;
		}
	}

	/**
	 * @description プロセスの終了を待機してexit codeを返す
	 * @returns exit code
	 */
	async wait(): Promise<number> {
		const resp = await this.#commandRouterClient.execWait(
			this.#taskId,
			this.#execId,
			this.#deadline,
		);
		if (resp.code !== undefined) {
			return resp.code;
		} else if (resp.signal !== undefined) {
			return 128 + resp.signal;
		} else {
			throw new InvalidError("Unexpected exit status");
		}
	}
}

// Python SDK の _StreamReader (object_type == "sandbox") に相当
async function* outputStreamSb(
	cpClient: ModalGrpcClient,
	sandboxId: string,
	fileDescriptor: FileDescriptor,
	signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
	let lastIndex = "0-0";
	let completed = false;
	let retriesRemaining = SB_LOGS_MAX_RETRIES;
	let delayMs = SB_LOGS_INITIAL_DELAY_MS;
	while (!completed) {
		try {
			const outputIterator = cpClient.sandboxGetLogs(
				{
					sandboxId,
					fileDescriptor,
					timeout: 55,
					lastEntryId: lastIndex,
				},
				{
					...(signal !== undefined && { signal }),
				},
			);
			for await (const batch of outputIterator) {
				// 読み取り成功 — バックオフカウンタをリセット
				delayMs = SB_LOGS_INITIAL_DELAY_MS;
				retriesRemaining = SB_LOGS_MAX_RETRIES;
				lastIndex = batch.entryId;
				yield* batch.items.map((item) => encodeIfString(item.data));
				if (batch.eof) {
					completed = true;
					break;
				}
				if (signal?.aborted) {
					return;
				}
			}
		} catch (err) {
			// キャンセル済みならエラー種別を問わず正常終了
			if (signal?.aborted) {
				return;
			}
			if (isRetryableGrpc(err) && retriesRemaining > 0) {
				// 連続リトライを避けるため短い指数バックオフ
				try {
					await setTimeout(delayMs, undefined, { signal });
				} catch {
					// スリープ中のキャンセル — 正常終了
					return;
				}
				delayMs *= SB_LOGS_DELAY_FACTOR;
				retriesRemaining--;
			} else {
				throw err;
			}
		}
	}
}

function inputStreamSb(
	cpClient: ModalGrpcClient,
	sandboxId: string,
): WritableStream<string> {
	let index = 1;
	return new WritableStream<string>({
		async write(chunk) {
			await cpClient.sandboxStdinWrite({
				sandboxId,
				input: encodeIfString(chunk),
				index,
			});
			index++;
		},
		async close() {
			await cpClient.sandboxStdinWrite({
				sandboxId,
				index,
				eof: true,
			});
		},
	});
}

async function* outputStreamCp(
	commandRouterClient: TaskCommandRouterClientImpl,
	taskId: string,
	execId: string,
	fileDescriptor: FileDescriptor,
	deadline: number | null,
): AsyncIterable<Uint8Array> {
	for await (const batch of commandRouterClient.execStdioRead(
		taskId,
		execId,
		fileDescriptor,
		deadline,
	)) {
		yield batch.data;
	}
}

function inputStreamCp<R extends string | Uint8Array>(
	commandRouterClient: TaskCommandRouterClientImpl,
	taskId: string,
	execId: string,
): WritableStream<R> {
	let offset = 0;
	return new WritableStream<R>({
		async write(chunk) {
			const data = encodeIfString(chunk);
			await commandRouterClient.execStdinWrite(
				taskId,
				execId,
				offset,
				data,
				false, // eof
			);
			offset += data.length;
		},
		async close() {
			await commandRouterClient.execStdinWrite(
				taskId,
				execId,
				offset,
				new Uint8Array(0),
				true, // eof
			);
		},
	});
}
