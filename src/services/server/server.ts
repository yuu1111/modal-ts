import { getDefaultClient, type ModalClient } from "@/core/client";
import type { Function_ } from "@/services/function/function";

/**
 * @description Server.fromName() のオプションパラメータ
 * @property environment - Environment 名 @optional
 */
export type ServerFromNameParams = {
	environment?: string;
	client?: ModalClient;
};

/**
 * @description Server の autoscaler 更新パラメータ
 */
export type ServerUpdateAutoscalerParams = {
	targetConcurrency?: number;
	minContainers?: number;
	maxContainers?: number;
	bufferContainers?: number;
	scaleupWindowMs?: number;
	scaledownWindowMs?: number;
};

/**
 * @description Modal Server
 */
export class Server {
	readonly #function: Function_;

	/**
	 * @internal
	 */
	constructor(fn: Function_) {
		this.#function = fn;
	}

	/**
	 * @description App 内の Server を名前で参照する
	 */
	static async fromName(
		appName: string,
		name: string,
		params: ServerFromNameParams = {},
	): Promise<Server> {
		const client = params.client ?? getDefaultClient();
		const fn = await client.functions.fromName(appName, name, {
			...(params.environment !== undefined && {
				environment: params.environment,
			}),
		});
		return new Server(fn);
	}

	/**
	 * @description Server の内部 object ID
	 */
	get objectId(): string {
		return this.#function.functionId;
	}

	/**
	 * @description Server URL を取得する
	 */
	async getUrl(): Promise<string | undefined> {
		return await this.#function.getWebUrl();
	}

	/**
	 * @description Server の autoscaler を更新する
	 */
	async updateAutoscaler(params: ServerUpdateAutoscalerParams): Promise<void> {
		await this.#function.updateAutoscaler({
			...(params.minContainers !== undefined && {
				minContainers: params.minContainers,
			}),
			...(params.maxContainers !== undefined && {
				maxContainers: params.maxContainers,
			}),
			...(params.bufferContainers !== undefined && {
				bufferContainers: params.bufferContainers,
			}),
			...(params.scaledownWindowMs !== undefined && {
				scaledownWindowMs: params.scaledownWindowMs,
			}),
			...(params.scaleupWindowMs !== undefined && {
				scaleupWindowMs: params.scaleupWindowMs,
			}),
			...(params.targetConcurrency !== undefined && {
				targetConcurrency: params.targetConcurrency,
			}),
		});
	}
}

/**
 * @description Server を管理するサービス
 */
export class ServerService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description App 内の Server を名前で参照する
	 */
	async fromName(
		appName: string,
		name: string,
		params: Omit<ServerFromNameParams, "client"> = {},
	): Promise<Server> {
		return await Server.fromName(appName, name, {
			...params,
			client: this.#client,
		});
	}
}
