import { ClientError, Status } from "nice-grpc";
import {
	AlreadyExistsError,
	InternalFailure,
	InvalidError,
	NotFoundError,
} from "@/core/errors";
import type { TaskCommandRouterClientImpl } from "@/core/grpc/task_command_router_client";
import {
	type GenericResult,
	GenericResult_GenericStatus,
} from "@/generated/modal_proto/api";
import {
	TaskContainerCreateRequest,
	TaskContainerGetRequest,
	type TaskContainerInfo,
	TaskContainerListRequest,
	TaskContainerTerminateRequest,
	TaskContainerWaitRequest,
} from "@/generated/modal_proto/task_command_router";
import type { Image } from "@/services/image/image";
import type { Secret } from "@/services/secret/secret";
import { type Volume, volumeToMountProto } from "@/services/volume/volume";
import type { SandboxExecParams } from "./sandbox_config";
import { validateExecArgs } from "./sandbox_config";
import { SandboxFilesystem } from "./sandbox_fs";
import type { ContainerProcess } from "./sandbox_process";

const MAIN_CONTAINER_NAME = "main";
const CONTAINER_WAIT_POLL_TIMEOUT_SECONDS = 10;

type SandboxSidecarCommandRouter = Pick<
	TaskCommandRouterClientImpl,
	| "containerCreate"
	| "containerGet"
	| "containerList"
	| "containerTerminate"
	| "containerWait"
>;

type SandboxSidecarAccess = {
	exec(
		command: string[],
		params: SandboxExecParams | undefined,
		containerId: string,
	): Promise<ContainerProcess>;
	commandRouter(): Promise<[string, SandboxSidecarCommandRouter]>;
	mergeEnvIntoSecrets(
		env: Record<string, string> | undefined,
		secrets: Secret[] | undefined,
	): Promise<Secret[]>;
};

/**
 * @description Sidecar 作成パラメータ
 */
export type SidecarCreateParams = {
	command?: string[];
	env?: Record<string, string>;
	secrets?: Secret[];
	workdir?: string;
	volumes?: Record<string, Volume>;
};

/**
 * @description Sidecar 取得パラメータ
 */
export type SidecarGetParams = {
	includeTerminated?: boolean;
};

/**
 * @description Sidecar 一覧パラメータ
 */
export type SidecarListParams = {
	includeTerminated?: boolean;
};

/**
 * @description Sidecar 内 exec パラメータ
 */
export type SidecarExecParams = SandboxExecParams;

/**
 * @description Sidecar 終了パラメータ
 */
export type SidecarTerminateParams = {
	wait?: boolean;
};

function validateSidecarName(name: string): void {
	if (name === "") {
		throw new InvalidError("sidecar name must not be empty");
	}
	if (name === MAIN_CONTAINER_NAME) {
		throw new InvalidError(
			`the name "${MAIN_CONTAINER_NAME}" is reserved for the Sandbox's main container. Use the Sandbox methods directly to interact with it`,
		);
	}
}

function validateWorkdir(workdir: string | undefined): void {
	if (workdir !== undefined && !workdir.startsWith("/")) {
		throw new InvalidError(`workdir must be an absolute path, got: ${workdir}`);
	}
}

function getReturnCode(result: GenericResult | undefined): number | null {
	if (
		result === undefined ||
		result.status === GenericResult_GenericStatus.GENERIC_STATUS_UNSPECIFIED
	) {
		return null;
	}
	if (result.status === GenericResult_GenericStatus.GENERIC_STATUS_TIMEOUT) {
		return 124;
	}
	if (result.status === GenericResult_GenericStatus.GENERIC_STATUS_TERMINATED) {
		return 137;
	}
	return result.exitcode ?? 0;
}

function sidecarContainerFromProto(
	access: SandboxSidecarAccess,
	info: TaskContainerInfo,
): SidecarContainer {
	return new SidecarContainer(
		access,
		info.containerId,
		info.containerName,
		info.result,
	);
}

/**
 * @description Sandbox 内の sidecar container を作成・管理するサービス
 */
export class SidecarService {
	readonly #access: SandboxSidecarAccess;

	/** @internal */
	constructor(access: SandboxSidecarAccess) {
		this.#access = access;
	}

	/**
	 * @description Sidecar container を起動する
	 * @param name - Sandbox 内で一意な sidecar 名
	 * @param image - 起動するビルド済み Image
	 * @param params - 作成パラメータ
	 */
	async create(
		name: string,
		image: Image,
		params?: SidecarCreateParams,
	): Promise<SidecarContainer> {
		validateSidecarName(name);
		if (!image || image.imageId === "") {
			throw new InvalidError(
				"sidecar image must already be built. Call image.build(app) first or use client.images.fromId(...)",
			);
		}

		const command = params?.command ?? [];
		validateExecArgs(command);
		validateWorkdir(params?.workdir);

		const mergedSecrets = await this.#access.mergeEnvIntoSecrets(
			params?.env,
			params?.secrets,
		);
		const secretIds = mergedSecrets.map((secret) => secret.secretId);
		const volumeMounts = params?.volumes
			? Object.entries(params.volumes).map(([mountPath, volume]) =>
					volumeToMountProto(mountPath, volume),
				)
			: [];
		const [taskId, client] = await this.#access.commandRouter();

		let resp: Awaited<
			ReturnType<SandboxSidecarCommandRouter["containerCreate"]>
		>;
		try {
			resp = await client.containerCreate(
				TaskContainerCreateRequest.create({
					taskId,
					containerName: name,
					imageId: image.imageId,
					args: command,
					env: params?.env ?? {},
					workdir: params?.workdir ?? "",
					secretIds,
					volumeMounts,
				}),
			);
		} catch (err) {
			if (err instanceof ClientError) {
				if (err.code === Status.ALREADY_EXISTS) {
					throw new AlreadyExistsError(err.details || err.message);
				}
				if (err.code === Status.INVALID_ARGUMENT) {
					throw new InvalidError(err.details || err.message);
				}
			}
			throw err;
		}

		return new SidecarContainer(
			this.#access,
			resp.containerId,
			resp.containerName || name,
		);
	}

	/**
	 * @description 名前で sidecar container を取得する
	 */
	async get(
		name: string,
		params?: SidecarGetParams,
	): Promise<SidecarContainer> {
		validateSidecarName(name);
		const [taskId, client] = await this.#access.commandRouter();

		let resp: Awaited<ReturnType<SandboxSidecarCommandRouter["containerGet"]>>;
		try {
			resp = await client.containerGet(
				TaskContainerGetRequest.create({
					taskId,
					containerName: name,
					includeTerminated: params?.includeTerminated ?? false,
				}),
			);
		} catch (err) {
			if (err instanceof ClientError && err.code === Status.NOT_FOUND) {
				throw new NotFoundError(`Sidecar container "${name}" not found`);
			}
			throw err;
		}
		if (!resp.container) {
			throw new InternalFailure(
				`server returned no container for sidecar "${name}"`,
			);
		}
		return sidecarContainerFromProto(this.#access, resp.container);
	}

	/**
	 * @description sidecar container の一覧を返す
	 */
	async list(params?: SidecarListParams): Promise<SidecarContainer[]> {
		const [taskId, client] = await this.#access.commandRouter();
		const resp = await client.containerList(
			TaskContainerListRequest.create({
				taskId,
				includeTerminated: params?.includeTerminated ?? false,
			}),
		);

		return resp.containers
			.filter((info) => info.containerName !== MAIN_CONTAINER_NAME)
			.map((info) => sidecarContainerFromProto(this.#access, info));
	}
}

/**
 * @description Sandbox 内で動作する sidecar container のハンドル
 */
export class SidecarContainer {
	readonly containerId: string;
	readonly containerName: string;

	readonly #access: SandboxSidecarAccess;
	#result?: GenericResult;
	#filesystem?: SandboxFilesystem;

	/** @internal */
	constructor(
		access: SandboxSidecarAccess,
		containerId: string,
		containerName: string,
		result?: GenericResult,
	) {
		this.#access = access;
		this.containerId = containerId;
		this.containerName = containerName;
		if (result !== undefined) this.#result = result;
	}

	get name(): string {
		return this.containerName;
	}

	get object_id(): string {
		return this.containerId;
	}

	get objectId(): string {
		return this.object_id;
	}

	async exec(
		command: string[],
		params?: SidecarExecParams & { mode?: "text" },
	): Promise<ContainerProcess<string>>;

	async exec(
		command: string[],
		params: SidecarExecParams & { mode: "binary" },
	): Promise<ContainerProcess<Uint8Array>>;

	/**
	 * @description sidecar container 内でコマンドを実行する
	 */
	async exec(
		command: string[],
		params?: SidecarExecParams,
	): Promise<ContainerProcess> {
		return this.#access.exec(command, params, this.containerId);
	}

	/**
	 * @description sidecar container 用 filesystem API
	 */
	get filesystem(): SandboxFilesystem {
		if (!this.#filesystem) {
			this.#filesystem = new SandboxFilesystem((command, params) =>
				this.#access.exec(command, params, this.containerId),
			);
		}
		return this.#filesystem;
	}

	/**
	 * @description sidecar container の終了を待ち exit code を返す
	 */
	async wait(
		params: {
			raiseOnTermination?: boolean;
			raise_on_termination?: boolean;
		} = {},
	): Promise<number> {
		if (
			this.#result &&
			this.#result.status !==
				GenericResult_GenericStatus.GENERIC_STATUS_UNSPECIFIED
		) {
			const raiseOnTermination =
				params.raiseOnTermination ?? params.raise_on_termination ?? false;
			if (
				raiseOnTermination &&
				this.#result.status ===
					GenericResult_GenericStatus.GENERIC_STATUS_TERMINATED
			) {
				throw new Error(`Sidecar container ${this.containerId} was terminated`);
			}
			return getReturnCode(this.#result) ?? 0;
		}

		const [taskId, client] = await this.#access.commandRouter();
		while (true) {
			const resp = await client.containerWait(
				TaskContainerWaitRequest.create({
					taskId,
					containerId: this.containerId,
					timeout: CONTAINER_WAIT_POLL_TIMEOUT_SECONDS,
				}),
			);
			const result = resp.result;
			if (
				!result ||
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_UNSPECIFIED
			) {
				continue;
			}
			this.#result = result;
			const raiseOnTermination =
				params.raiseOnTermination ?? params.raise_on_termination ?? false;
			if (
				raiseOnTermination &&
				result.status === GenericResult_GenericStatus.GENERIC_STATUS_TERMINATED
			) {
				throw new Error(`Sidecar container ${this.containerId} was terminated`);
			}
			return getReturnCode(result) ?? 0;
		}
	}

	/**
	 * @description sidecar container の終了状態を確認する。実行中なら null
	 */
	async poll(): Promise<number | null> {
		if (
			this.#result &&
			this.#result.status !==
				GenericResult_GenericStatus.GENERIC_STATUS_UNSPECIFIED
		) {
			return getReturnCode(this.#result);
		}

		const [taskId, client] = await this.#access.commandRouter();
		const resp = await client.containerWait(
			TaskContainerWaitRequest.create({
				taskId,
				containerId: this.containerId,
				timeout: 0,
			}),
		);
		const result = resp.result;
		if (
			result &&
			result.status !== GenericResult_GenericStatus.GENERIC_STATUS_UNSPECIFIED
		) {
			this.#result = result;
		}
		return getReturnCode(result);
	}

	async terminate(): Promise<undefined>;
	async terminate(params: { wait: true }): Promise<number>;

	/**
	 * @description sidecar container を停止する
	 */
	async terminate(
		params?: SidecarTerminateParams,
	): Promise<number | undefined> {
		const [taskId, client] = await this.#access.commandRouter();
		await client.containerTerminate(
			TaskContainerTerminateRequest.create({
				taskId,
				containerId: this.containerId,
			}),
		);
		if (params?.wait) {
			return this.wait();
		}
	}
}
