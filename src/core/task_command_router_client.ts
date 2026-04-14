import { setTimeout } from "node:timers/promises";
import {
	type CallOptions,
	ChannelCredentials,
	type Client,
	ClientError,
	createChannel,
	createClientFactory,
	Metadata,
	Status,
} from "nice-grpc";
import {
	FileDescriptor,
	TaskGetCommandRouterAccessRequest,
	type TaskGetCommandRouterAccessResponse,
} from "@/generated/modal_proto/api";
import {
	TaskCommandRouterDefinition,
	TaskExecPollRequest,
	type TaskExecPollResponse,
	type TaskExecStartRequest,
	type TaskExecStartResponse,
	TaskExecStdinWriteRequest,
	type TaskExecStdinWriteResponse,
	TaskExecStdioFileDescriptor,
	TaskExecStdioReadRequest,
	type TaskExecStdioReadResponse,
	TaskExecWaitRequest,
	type TaskExecWaitResponse,
	type TaskMountDirectoryRequest,
	type TaskSnapshotDirectoryRequest,
	type TaskSnapshotDirectoryResponse,
	type TaskUnmountDirectoryRequest,
} from "@/generated/modal_proto/task_command_router";
import type { Logger } from "@/utils/logger";
import { decodeJwtExp } from "./auth_token_manager";
import type { ModalGrpcClient } from "./client";
import { GRPC_CHANNEL_OPTIONS } from "./client";
import type { Profile } from "./config";
import { isLocalhost } from "./config";
import { ClientClosedError } from "./errors";
import {
	isRetryableGrpc,
	type TimeoutOptions,
	timeoutMiddleware,
} from "./grpc_utils";

/**
 * @description TaskCommandRouterサービスのgRPCクライアント型
 */
type TaskCommandRouterClient = Client<typeof TaskCommandRouterDefinition>;

/**
 * @description FileDescriptorからTaskExecStdioFileDescriptorへの変換マップ
 */
const FD_MAP: Partial<Record<FileDescriptor, TaskExecStdioFileDescriptor>> = {
	[FileDescriptor.FILE_DESCRIPTOR_STDOUT]:
		TaskExecStdioFileDescriptor.TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDOUT,
	[FileDescriptor.FILE_DESCRIPTOR_STDERR]:
		TaskExecStdioFileDescriptor.TASK_EXEC_STDIO_FILE_DESCRIPTOR_STDERR,
};

/**
 * @description トランジェントエラーリトライの設定
 * @property baseDelayMs - 初回リトライ待機時間 @optional @defaultValue 10
 * @property delayFactor - バックオフ倍率 @optional @defaultValue 2
 * @property maxRetries - 最大リトライ回数(nullで無制限) @optional @defaultValue 10
 * @property deadlineMs - 全体のデッドライン(エポックミリ秒) @optional
 * @property isClosed - クライアント閉鎖判定関数 @optional
 */
export interface TransientRetryOptions {
	baseDelayMs?: number;
	delayFactor?: number;
	maxRetries?: number | null;
	deadlineMs?: number | null;
	isClosed?: () => boolean;
}

/**
 * @description トランジェントエラー時に指数バックオフでリトライする
 * @param func - リトライ対象の非同期関数
 * @param options - リトライ設定
 */
export async function callWithRetriesOnTransientErrors<T>(
	func: () => Promise<T>,
	options: TransientRetryOptions = {},
): Promise<T> {
	const {
		baseDelayMs = 10,
		delayFactor = 2,
		maxRetries = 10,
		deadlineMs = null,
		isClosed,
	} = options;
	let delayMs = baseDelayMs;
	let numRetries = 0;

	while (true) {
		if (deadlineMs !== null && Date.now() >= deadlineMs) {
			throw new Error("Deadline exceeded");
		}

		try {
			return await func();
		} catch (err) {
			if (
				err instanceof ClientError &&
				err.code === Status.CANCELLED &&
				isClosed?.()
			) {
				throw new ClientClosedError();
			}
			if (
				isRetryableGrpc(err) &&
				(maxRetries === null || numRetries < maxRetries)
			) {
				if (deadlineMs !== null && Date.now() + delayMs >= deadlineMs) {
					throw new Error("Deadline exceeded");
				}

				await setTimeout(delayMs);
				delayMs *= delayFactor;
				numRetries++;
			} else {
				throw err;
			}
		}
	}
}

/** @internal */
export class TaskCommandRouterClientImpl {
	private stub: TaskCommandRouterClient;
	private channel: ReturnType<typeof createChannel>;
	private serverClient: ModalGrpcClient;
	private taskId: string;
	private serverUrl: string;
	private jwt: string;
	private jwtExp: number | null;
	private jwtRefreshPromise: Promise<void> | null = null;
	private logger: Logger;
	private closed: boolean = false;

	/**
	 * @description callWithRetriesOnTransientErrors に渡す閉鎖判定コールバック
	 */
	private readonly retryOptions: Pick<TransientRetryOptions, "isClosed"> = {
		isClosed: () => this.closed,
	};

	static async tryInit(
		serverClient: ModalGrpcClient,
		taskId: string,
		logger: Logger,
		profile: Profile,
	): Promise<TaskCommandRouterClientImpl | null> {
		let resp: TaskGetCommandRouterAccessResponse;
		try {
			resp = await serverClient.taskGetCommandRouterAccess(
				TaskGetCommandRouterAccessRequest.create({ taskId }),
			);
		} catch (err) {
			if (
				err instanceof ClientError &&
				err.code === Status.FAILED_PRECONDITION
			) {
				logger.debug(
					"Command router access is not enabled for task",
					"task_id",
					taskId,
				);
				return null;
			}
			throw err;
		}

		logger.debug(
			"Using command router access for task",
			"task_id",
			taskId,
			"url",
			resp.url,
		);

		const url = new URL(resp.url);
		if (url.protocol !== "https:") {
			throw new Error(`Task router URL must be https, got: ${resp.url}`);
		}

		const host = url.hostname;
		const port = url.port ? parseInt(url.port, 10) : 443;
		const serverUrl = `${host}:${port}`;
		if (isLocalhost(profile)) {
			logger.warn(
				"Using insecure TLS (skip certificate verification) for task command router",
			);
		}
		const channel = createChannel(
			serverUrl,
			isLocalhost(profile)
				? ChannelCredentials.createInsecure()
				: ChannelCredentials.createSsl(),
			GRPC_CHANNEL_OPTIONS,
		);

		const client = new TaskCommandRouterClientImpl(
			serverClient,
			taskId,
			resp.url,
			resp.jwt,
			channel,
			logger,
		);

		logger.debug(
			"Successfully initialized command router client",
			"task_id",
			taskId,
		);

		return client;
	}

	private constructor(
		serverClient: ModalGrpcClient,
		taskId: string,
		serverUrl: string,
		jwt: string,
		channel: ReturnType<typeof createChannel>,
		logger: Logger,
	) {
		this.serverClient = serverClient;
		this.taskId = taskId;
		this.serverUrl = serverUrl;
		this.jwt = jwt;
		this.jwtExp = decodeJwtExp(jwt);
		this.logger = logger;
		this.channel = channel;

		// ジェネレータ関数はアロー関数にできないため、thisをキャプチャしてJWTリフレッシュ後のアクセスに使用
		const self = this;

		const factory = createClientFactory()
			.use(timeoutMiddleware)
			.use(async function* authMiddleware(call, options: CallOptions) {
				options.metadata ??= new Metadata();
				options.metadata.set("authorization", `Bearer ${self.jwt}`);
				return yield* call.next(call.request, options);
			});

		this.stub = factory.create(TaskCommandRouterDefinition, channel);
	}

	close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.channel.close();
	}

	async execStart(
		request: TaskExecStartRequest,
	): Promise<TaskExecStartResponse> {
		return await callWithRetriesOnTransientErrors(
			() => this.callWithAuthRetry(() => this.stub.taskExecStart(request)),
			this.retryOptions,
		);
	}

	async *execStdioRead(
		taskId: string,
		execId: string,
		fileDescriptor: FileDescriptor,
		deadline: number | null = null,
	): AsyncGenerator<TaskExecStdioReadResponse> {
		const srFd = FD_MAP[fileDescriptor];
		if (srFd === undefined) {
			throw new Error(`Unsupported file descriptor: ${fileDescriptor}`);
		}

		yield* this.streamStdio(taskId, execId, srFd, deadline);
	}

	async execStdinWrite(
		taskId: string,
		execId: string,
		offset: number,
		data: Uint8Array,
		eof: boolean,
	): Promise<TaskExecStdinWriteResponse> {
		const request = TaskExecStdinWriteRequest.create({
			taskId,
			execId,
			offset,
			data,
			eof,
		});
		return await callWithRetriesOnTransientErrors(
			() => this.callWithAuthRetry(() => this.stub.taskExecStdinWrite(request)),
			this.retryOptions,
		);
	}

	async execPoll(
		taskId: string,
		execId: string,
		deadline: number | null = null,
	): Promise<TaskExecPollResponse> {
		const request = TaskExecPollRequest.create({ taskId, execId });
		// タイムアウトはコマンドルーターとの通信がハングした場合のバックストップ。
		// poll自体は通常即座に完了する
		return await this.callWithDeadline(
			() => this.callWithAuthRetry(() => this.stub.taskExecPoll(request)),
			`polling for exec ${execId}`,
			deadline,
		);
	}

	async execWait(
		taskId: string,
		execId: string,
		deadline: number | null = null,
	): Promise<TaskExecWaitResponse> {
		const request = TaskExecWaitRequest.create({ taskId, execId });
		return await this.callWithDeadline(
			() =>
				this.callWithAuthRetry(() =>
					this.stub.taskExecWait(request, {
						timeoutMs: 60000,
					} as CallOptions & TimeoutOptions),
				),
			`waiting for exec ${execId}`,
			deadline,
			{
				// 完了まで長時間かかるため1秒間隔でリトライ
				baseDelayMs: 1000,
				delayFactor: 1,
				maxRetries: null,
			},
		);
	}

	async mountDirectory(request: TaskMountDirectoryRequest): Promise<void> {
		await callWithRetriesOnTransientErrors(
			() => this.callWithAuthRetry(() => this.stub.taskMountDirectory(request)),
			this.retryOptions,
		);
	}

	async unmountDirectory(request: TaskUnmountDirectoryRequest): Promise<void> {
		await callWithRetriesOnTransientErrors(
			() =>
				this.callWithAuthRetry(() => this.stub.taskUnmountDirectory(request)),
			this.retryOptions,
		);
	}

	async snapshotDirectory(
		request: TaskSnapshotDirectoryRequest,
	): Promise<TaskSnapshotDirectoryResponse> {
		return await callWithRetriesOnTransientErrors(
			() =>
				this.callWithAuthRetry(() => this.stub.taskSnapshotDirectory(request)),
			this.retryOptions,
		);
	}

	private async refreshJwt(): Promise<void> {
		if (this.jwtRefreshPromise) {
			return this.jwtRefreshPromise;
		}

		if (this.closed) {
			return;
		}

		// 現在のJWT有効期限が十分先なら再取得をスキップ。
		// 複数の並行リクエストが同時にUNAUTHENTICATEDを受けた場合に発生しうる
		if (this.jwtExp !== null && this.jwtExp - Date.now() / 1000 > 30) {
			this.logger.debug(
				"Skipping JWT refresh because expiration is far enough in the future",
				"task_id",
				this.taskId,
			);
			return;
		}

		this.jwtRefreshPromise = this.doRefreshJwt().finally(() => {
			this.jwtRefreshPromise = null;
		});

		return this.jwtRefreshPromise;
	}

	private async doRefreshJwt(): Promise<void> {
		const resp = await this.serverClient.taskGetCommandRouterAccess(
			TaskGetCommandRouterAccessRequest.create({ taskId: this.taskId }),
		);

		if (resp.url !== this.serverUrl) {
			throw new Error("Task router URL changed during session");
		}

		this.jwt = resp.jwt;
		this.jwtExp = decodeJwtExp(resp.jwt);
	}

	/**
	 * @description UNAUTHENTICATED エラー時にJWTをリフレッシュして1回リトライする
	 */
	private async callWithAuthRetry<T>(func: () => Promise<T>): Promise<T> {
		try {
			return await func();
		} catch (err) {
			if (err instanceof ClientError && err.code === Status.UNAUTHENTICATED) {
				await this.refreshJwt();
				return await func();
			}
			throw err;
		}
	}

	/**
	 * @description デッドライン付きでリトライを実行する。デッドライン超過時は統一メッセージでスロー
	 * @param func - リトライ対象の非同期関数
	 * @param operationLabel - エラーメッセージに使う操作名(例: "polling for exec abc")
	 * @param deadline - デッドライン(エポックミリ秒、nullなら無制限) @optional
	 * @param extraOptions - 追加のリトライ設定 @optional
	 */
	private async callWithDeadline<T>(
		func: () => Promise<T>,
		operationLabel: string,
		deadline: number | null,
		extraOptions?: Omit<TransientRetryOptions, "deadlineMs" | "isClosed">,
	): Promise<T> {
		if (deadline !== null && deadline <= Date.now()) {
			throw new Error(`Deadline exceeded while ${operationLabel}`);
		}

		try {
			return await callWithRetriesOnTransientErrors(func, {
				...extraOptions,
				deadlineMs: deadline,
				...this.retryOptions,
			});
		} catch (err) {
			if (err instanceof ClientError && err.code === Status.DEADLINE_EXCEEDED) {
				throw new Error(`Deadline exceeded while ${operationLabel}`);
			}
			throw err;
		}
	}

	private async *streamStdio(
		taskId: string,
		execId: string,
		fileDescriptor: TaskExecStdioFileDescriptor,
		deadline: number | null,
	): AsyncGenerator<TaskExecStdioReadResponse> {
		let offset = 0;
		let delayMs = 10;
		const delayFactor = 2;
		let numRetriesRemaining = 10;
		// JWTリフレッシュ後も無効なJWTが返された場合の無限リトライを防止するフラグ
		let didAuthRetry = false;

		while (true) {
			try {
				const timeoutMs =
					deadline !== null ? Math.max(0, deadline - Date.now()) : undefined;

				const request = TaskExecStdioReadRequest.create({
					taskId,
					execId,
					offset,
					fileDescriptor,
				});

				const stream = this.stub.taskExecStdioRead(request, {
					timeoutMs,
				} as CallOptions & TimeoutOptions);

				try {
					for await (const item of stream) {
						didAuthRetry = false;
						delayMs = 10;
						offset += item.data.length;
						yield item;
					}
					return;
				} catch (err) {
					if (
						err instanceof ClientError &&
						err.code === Status.UNAUTHENTICATED &&
						!didAuthRetry
					) {
						await this.refreshJwt();
						didAuthRetry = true;
						continue;
					}
					throw err;
				}
			} catch (err) {
				if (
					err instanceof ClientError &&
					err.code === Status.CANCELLED &&
					this.closed
				) {
					throw new ClientClosedError();
				}
				if (isRetryableGrpc(err) && numRetriesRemaining > 0) {
					if (deadline && deadline - Date.now() <= delayMs) {
						throw new Error(
							`Deadline exceeded while streaming stdio for exec ${execId}`,
						);
					}

					this.logger.debug(
						"Retrying stdio read with delay",
						"delay_ms",
						delayMs,
						"error",
						err,
					);
					await setTimeout(delayMs);
					delayMs *= delayFactor;
					numRetriesRemaining--;
				} else {
					throw err;
				}
			}
		}
	}
}
