import { setTimeout } from "node:timers/promises";
import { ClientError, Status } from "nice-grpc";
import { v4 as uuidv4 } from "uuid";
import { getDefaultClient, type ModalClient } from "@/core/client";
import {
	ClientClosedError,
	InvalidError,
	SandboxTimeoutError,
	TimeoutError,
} from "@/core/errors";
import {
	rethrowAlreadyExists,
	rethrowInvalid,
	rethrowNotFound,
} from "@/core/grpc/errors";
import { TaskCommandRouterClientImpl } from "@/core/grpc/task_command_router_client";
import {
	FileDescriptor,
	type GenericResult,
	GenericResult_GenericStatus,
	NetworkAccess,
	NetworkAccess_NetworkAccessType,
	type SandboxTagsGetResponse,
} from "@/generated/modal_proto/api";
import {
	TaskMountDirectoryRequest,
	TaskReloadVolumesRequest,
	TaskSetNetworkAccessRequest,
	TaskSnapshotDirectoryRequest,
	TaskSnapshotFilesystemRequest,
	TaskUnmountDirectoryRequest,
} from "@/generated/modal_proto/task_command_router";
import type { App } from "@/services/deploy/app";
import { Image } from "@/services/image/image";
import { mergeEnvIntoSecrets } from "@/services/secret/secret";
import {
	encodeIfString,
	type ModalReadStream,
	type ModalWriteStream,
	streamConsumingIter,
	toModalReadStream,
	toModalWriteStream,
} from "@/utils/streams";
import {
	buildSandboxCreateRequestProto,
	buildSandboxCreateV2RequestProto,
	buildTaskExecStartRequestProto,
	type SandboxCreateParams,
	type SandboxExecParams,
	type SandboxExperimentalListParams,
	type SandboxFromNameParams,
	type SandboxListParams,
	type SandboxMountImageParams,
	type SandboxSnapshotDirectoryParams,
	type SandboxSnapshotFilesystemParams,
	type SandboxTerminateParams,
	type SandboxUpdateNetworkPolicyParams,
	validateExecArgs,
} from "./sandbox_config";
import {
	runFilesystemExec,
	SandboxFile,
	type SandboxFileMode,
} from "./sandbox_filesystem";
import { SandboxFilesystem } from "./sandbox_fs";
import { ContainerProcess } from "./sandbox_process";
import { SidecarService } from "./sandbox_sidecar";
import { inputStreamSb, outputStreamSb } from "./sandbox_streams";
import {
	type SandboxCreateConnectCredentials,
	type SandboxCreateConnectTokenParams,
	Tunnel,
} from "./sandbox_tunnel";

/**
 * @description {@link Sandbox} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
 * ```typescript
 * const modal = new ModalClient();
 * const sb = await modal.sandboxes.create(app, image);
 * ```
 */
function resolveTtlSeconds(ttlMs: number | null | undefined): number {
	if (ttlMs === undefined) {
		return 30 * 24 * 3600;
	}
	if (ttlMs === null) {
		return -1;
	}
	if (ttlMs < 1000) {
		throw new InvalidError(`ttlMs must be at least 1000ms, got ${ttlMs}`);
	}
	if (ttlMs % 1000 !== 0) {
		throw new InvalidError(`ttlMs must be a multiple of 1000ms, got ${ttlMs}`);
	}
	return ttlMs / 1000;
}

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
			mountIds: [
				...(restParams.mountIds ?? []),
				...(await image.mountIds(app)),
			],
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
	 * @description 実験的 V2 backend で Sandbox を作成する
	 * @param app - Appインスタンス
	 * @param image - コンテナイメージ
	 * @param params - Sandbox作成パラメータ
	 * @returns 作成された V2 Sandbox
	 */
	async experimentalCreate(
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
			mountIds: [
				...(restParams.mountIds ?? []),
				...(await image.mountIds(app)),
			],
		};

		const createReq = await buildSandboxCreateV2RequestProto(
			app.appId,
			image.imageId,
			mergedParams,
		);
		const createResp = await this.#client.cpClient
			.sandboxCreateV2(createReq)
			.catch(rethrowAlreadyExists);

		this.#client.logger.debug(
			"Created experimental V2 Sandbox",
			"sandbox_id",
			createResp.sandboxId,
		);

		const tunnels =
			createResp.tunnels.length > 0
				? Object.fromEntries(
						createResp.tunnels.map((t) => [
							t.containerPort,
							new Tunnel(t.host, t.port, t.unencryptedHost, t.unencryptedPort),
						]),
					)
				: undefined;

		return new Sandbox(
			this.#client,
			createResp.sandboxId,
			true,
			createResp.taskId,
			tunnels,
		);
	}

	/**
	 * @description IDから実行中のSandboxを取得する
	 * @param sandboxId - Sandbox ID
	 * @returns Sandboxインスタンス
	 * @throws NotFoundError 指定されたSandboxが存在しない場合
	 */
	async fromId(sandboxId: string): Promise<Sandbox> {
		const isV2 = Sandbox.isV2SandboxId(sandboxId);
		if (isV2) {
			return new Sandbox(this.#client, sandboxId, true);
		}
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

	async from_id(sandboxId: string): Promise<Sandbox> {
		return await this.fromId(sandboxId);
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

	async from_name(
		appName: string,
		name: string,
		params?: SandboxFromNameParams,
	): Promise<Sandbox> {
		return await this.fromName(appName, name, params);
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

	/**
	 * @description 実験的 V2 Sandbox の一覧を返す
	 * @param params - フィルタリングパラメータ
	 */
	async *experimentalList(
		params: SandboxExperimentalListParams,
	): AsyncGenerator<Sandbox, void, unknown> {
		if (!params?.appId) {
			throw new InvalidError(
				"experimentalList requires an `appId`:\n\n" +
					'const app = await modal.apps.fromName("my-app");\n' +
					"modal.sandboxes.experimentalList({ appId: app.appId });",
			);
		}

		let beforeTimestamp: number | undefined;
		while (true) {
			const resp = await this.#client.cpClient.sandboxListV2({
				appId: params.appId,
				...(beforeTimestamp !== undefined && { beforeTimestamp }),
				includeFinished: false,
			});
			if (!resp.sandboxes || resp.sandboxes.length === 0) {
				return;
			}
			for (const info of resp.sandboxes) {
				yield new Sandbox(this.#client, info.id, true);
			}
			beforeTimestamp = resp.sandboxes[resp.sandboxes.length - 1]?.createdAt;
		}
	}
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
	#filesystem: SandboxFilesystem | undefined;
	#experimentalSidecars: SidecarService | undefined;
	#isV2: boolean;

	/** @internal */
	constructor(
		client: ModalClient,
		sandboxId: string,
		isV2 = false,
		taskId?: string,
		tunnels?: Record<number, Tunnel>,
	) {
		this.#client = client;
		this.sandboxId = sandboxId;
		this.#isV2 = isV2;
		if (taskId !== undefined) this.#taskId = taskId;
		if (tunnels !== undefined) this.#tunnels = tunnels;
	}

	static isV2SandboxId(sandboxId: string): boolean {
		const [prefix, suffix, ...extra] = sandboxId.split("-");
		const ulidAlphabet = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
		return (
			prefix === "sb" &&
			extra.length === 0 &&
			suffix !== undefined &&
			suffix.length === 26 &&
			"01234567".includes(suffix[0] ?? "") &&
			Array.from(suffix).every((ch) => ulidAlphabet.has(ch))
		);
	}

	static async create(
		app: App,
		image: Image,
		params: SandboxCreateParams = {},
	): Promise<Sandbox> {
		return await getDefaultClient().sandboxes.create(app, image, params);
	}

	static async fromId(sandboxId: string): Promise<Sandbox> {
		return await getDefaultClient().sandboxes.fromId(sandboxId);
	}

	static async from_id(sandboxId: string): Promise<Sandbox> {
		return await Sandbox.fromId(sandboxId);
	}

	static async fromName(
		appName: string,
		name: string,
		params?: SandboxFromNameParams,
	): Promise<Sandbox> {
		return await getDefaultClient().sandboxes.fromName(appName, name, params);
	}

	static async from_name(
		appName: string,
		name: string,
		params?: SandboxFromNameParams,
	): Promise<Sandbox> {
		return await Sandbox.fromName(appName, name, params);
	}

	static list(
		params: SandboxListParams = {},
	): AsyncGenerator<Sandbox, void, unknown> {
		return getDefaultClient().sandboxes.list(params);
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
	 * @description Sandbox filesystem API の namespace
	 */
	get filesystem(): SandboxFilesystem {
		if (!this.#filesystem) {
			this.#filesystem = new SandboxFilesystem((command, params) =>
				this.exec(command, params as SandboxExecParams & { mode: "binary" }),
			);
		}
		return this.#filesystem;
	}

	/**
	 * @description Sandbox 内 sidecar container API の namespace
	 */
	get experimentalSidecars(): SidecarService {
		if (!this.#experimentalSidecars) {
			this.#experimentalSidecars = new SidecarService({
				exec: (command, params, containerId) =>
					this.#exec(command, params, containerId),
				commandRouter: async () => {
					const taskId = await this.#getTaskId();
					const commandRouter =
						await this.#getOrCreateCommandRouterClient(taskId);
					return [taskId, commandRouter];
				},
				mergeEnvIntoSecrets: async (env, secrets) =>
					await mergeEnvIntoSecrets(this.#client, env, secrets),
			});
		}
		return this.#experimentalSidecars;
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

	async set_tags(tags: Record<string, string>): Promise<void> {
		await this.setTags(tags);
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

	async get_tags(): Promise<Record<string, string>> {
		return await this.getTags();
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
		return this.#exec(command, params);
	}

	async #exec(
		command: string[],
		params?: SandboxExecParams,
		containerId?: string,
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
			containerId,
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
			const resp = this.#isV2
				? await this.#client.cpClient.sandboxGetTaskIdV2({
						sandboxId: this.sandboxId,
					})
				: await this.#client.cpClient.sandboxGetTaskId({
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
				this.sandboxId,
				this.#isV2,
			);
			if (!client) {
				throw new Error("Command router access requires a running sandbox");
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
		} finally {
			// 成功時: 解決済みPromiseの保持を防ぐ
			// 失敗時: 後続の呼び出しでリトライできるようクリア
			if (this.#commandRouterClientPromise === promise) {
				this.#commandRouterClientPromise = undefined;
			}
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

	async create_connect_token(
		params: SandboxCreateConnectTokenParams = {},
	): Promise<SandboxCreateConnectCredentials> {
		return await this.createConnectToken(params);
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

		if (this.#isV2) {
			const taskId = await this.#getTaskId();
			const commandRouter = await this.#getOrCreateCommandRouterClient(taskId);
			await commandRouter.sandboxWaitUntilReady(taskId, timeoutMs);
			return;
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

	async wait_until_ready(timeoutMs = 300_000): Promise<void> {
		await this.waitUntilReady(timeoutMs);
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

	get returncode(): Promise<number | null> {
		return this.poll();
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
	 * @param paramsOrTimeoutMs - スナップショット操作のパラメータ、または旧形式のタイムアウト(ミリ秒)
	 * @returns {@link Image}
	 */
	async snapshotFilesystem(
		paramsOrTimeoutMs: SandboxSnapshotFilesystemParams | number = {},
	): Promise<Image> {
		this.#ensureAttached();
		const params =
			typeof paramsOrTimeoutMs === "number"
				? { timeoutMs: paramsOrTimeoutMs }
				: paramsOrTimeoutMs;
		const timeoutMs = params.timeoutMs ?? 55000;

		if (this.#isV2) {
			const taskId = await this.#getTaskId();
			const commandRouterClient =
				await this.#getOrCreateCommandRouterClient(taskId);
			const resp = await commandRouterClient.snapshotFilesystem(
				TaskSnapshotFilesystemRequest.create({
					taskId,
					snapshotId: uuidv4(),
					ttlSeconds: resolveTtlSeconds(params.ttlMs),
					customerSuppliedEncryptionKey: params.experimentalEncryptionKey,
				}),
			);
			if (!resp.imageId) {
				throw new Error("Sandbox snapshot response missing `imageId`");
			}
			return new Image(this.#client, resp.imageId, "");
		}

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

	async snapshot_filesystem(
		params: SandboxSnapshotFilesystemParams = {},
	): Promise<Image> {
		return await this.snapshotFilesystem(params);
	}

	/**
	 * @description Sandbox ファイルシステムのパスに {@link Image} をマウントする
	 * @param path - マウント先のパス
	 * @param image - マウントする {@link Image}。未指定なら空ディレクトリをマウント
	 */
	async mountImage(
		path: string,
		image?: Image,
		params: SandboxMountImageParams = {},
	): Promise<void> {
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
			customerSuppliedEncryptionKey: params.experimentalEncryptionKey,
		});
		await commandRouterClient.mountDirectory(request);
	}

	async mount_image(
		image: Image,
		path: string,
		params: SandboxMountImageParams = {},
	): Promise<void> {
		await this.mountImage(path, image, params);
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

	async unmount_image(path: string): Promise<void> {
		await this.unmountImage(path);
	}

	/**
	 * @description 実行中の Sandbox 内のディレクトリをスナップショットし新しい {@link Image} を作成する
	 * @param path - スナップショット対象のディレクトリパス
	 * @param params - スナップショットパラメータ
	 * @returns {@link Image}
	 */
	async snapshotDirectory(
		path: string,
		params: SandboxSnapshotDirectoryParams = {},
	): Promise<Image> {
		this.#ensureAttached();
		const taskId = await this.#getTaskId();
		const commandRouterClient =
			await this.#getOrCreateCommandRouterClient(taskId);

		const pathBytes = encodeIfString(path);
		const request = TaskSnapshotDirectoryRequest.create({
			taskId,
			path: pathBytes,
			snapshotId: uuidv4(),
			ttlSeconds: resolveTtlSeconds(params.ttlMs),
			customerSuppliedEncryptionKey: params.experimentalEncryptionKey,
		});
		const response = await commandRouterClient.snapshotDirectory(request);

		if (!response.imageId) {
			throw new Error("Sandbox snapshot directory response missing `imageId`");
		}

		return new Image(this.#client, response.imageId, "");
	}

	async snapshot_directory(
		path: string,
		params: SandboxSnapshotDirectoryParams = {},
	): Promise<Image> {
		return await this.snapshotDirectory(path, params);
	}

	/**
	 * @description Sandbox の outbound network policy を更新する
	 * @param params - network policy パラメータ
	 */
	async updateNetworkPolicy(
		params: SandboxUpdateNetworkPolicyParams,
	): Promise<void> {
		this.#ensureAttached();
		if (
			params.outboundCidrAllowlist === undefined ||
			params.outboundDomainAllowlist === undefined
		) {
			throw new InvalidError(
				"updateNetworkPolicy currently requires both outboundCidrAllowlist and outboundDomainAllowlist to be set",
			);
		}
		const taskId = await this.#getTaskId();
		const commandRouterClient =
			await this.#getOrCreateCommandRouterClient(taskId);
		await commandRouterClient.setNetworkAccess(
			TaskSetNetworkAccessRequest.create({
				taskId,
				networkAccess: NetworkAccess.create({
					networkAccessType: NetworkAccess_NetworkAccessType.ALLOWLIST,
					allowedCidrs: params.outboundCidrAllowlist,
					allowedDomains: params.outboundDomainAllowlist,
				}),
			}),
		);
	}

	/**
	 * @description Sandbox にマウントされた Volume を最新コミット状態へ reload する
	 */
	async reloadVolumes(): Promise<void> {
		this.#ensureAttached();
		const taskId = await this.#getTaskId();
		const commandRouterClient =
			await this.#getOrCreateCommandRouterClient(taskId);
		await commandRouterClient.reloadVolumes(
			TaskReloadVolumesRequest.create({ taskId }),
		);
	}

	async reload_volumes(): Promise<void> {
		await this.reloadVolumes();
	}

	async ls(path: string): Promise<unknown[]> {
		return await this.filesystem.listFiles(path);
	}

	async mkdir(
		path: string,
		params: { parents?: boolean; createParents?: boolean } = {},
	): Promise<void> {
		const createParents = params.createParents ?? params.parents;
		await this.filesystem.makeDirectory(
			path,
			createParents === undefined ? undefined : { createParents },
		);
	}

	async rm(path: string, params: { recursive?: boolean } = {}): Promise<void> {
		await this.filesystem.remove(path, params);
	}

	async *watch(
		path: string,
		params: { intervalMs?: number } = {},
	): AsyncGenerator<unknown[], void, unknown> {
		const intervalMs = params.intervalMs ?? 1000;
		while (true) {
			yield await this.filesystem.listFiles(path);
			await setTimeout(intervalMs);
		}
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
