import { setTimeout } from "node:timers/promises";
import { ClientError, Status } from "nice-grpc";
import { v4 as uuidv4 } from "uuid";
import type { ModalClient } from "@/core/client";
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
	type SandboxTagsGetResponse,
} from "@/generated/modal_proto/api";
import {
	TaskMountDirectoryRequest,
	TaskSnapshotDirectoryRequest,
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
	buildTaskExecStartRequestProto,
	type SandboxCreateParams,
	type SandboxExecParams,
	type SandboxFromNameParams,
	type SandboxListParams,
	type SandboxTerminateParams,
	validateExecArgs,
} from "./sandbox_config";
import {
	runFilesystemExec,
	SandboxFile,
	type SandboxFileMode,
} from "./sandbox_filesystem";
import { ContainerProcess } from "./sandbox_process";
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
