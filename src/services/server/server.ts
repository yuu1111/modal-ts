import { getDefaultClient, type ModalClient } from "@/core/client";
import type { Function_ } from "@/services/function/function";
import { aliasedNumber, environmentParam } from "@/utils/param_aliases";

/**
 * @description Optional parameters for Server.fromName()
 * @property environment - Environment name @optional
 */
export type ServerFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	client?: ModalClient;
};

/**
 * @description Parameters for updating a Server autoscaler
 */
export type ServerUpdateAutoscalerParams = {
	targetConcurrency?: number;
	target_concurrency?: number;
	minContainers?: number;
	min_containers?: number;
	maxContainers?: number;
	max_containers?: number;
	bufferContainers?: number;
	buffer_containers?: number;
	scaleupWindowMs?: number;
	scaleup_window?: number;
	scaleup_window_ms?: number;
	scaledownWindowMs?: number;
	scaledown_window?: number;
	scaledown_window_ms?: number;
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
	 * @description Looks up a Server inside an App by name
	 */
	static async fromName(
		appName: string,
		name: string,
		params: ServerFromNameParams = {},
	): Promise<Server> {
		const client = params.client ?? getDefaultClient();
		const environment = environmentParam(params);
		const fn = await client.functions.fromName(appName, name, {
			...(environment !== undefined && { environment }),
		});
		return new Server(fn);
	}

	static async from_name(
		appName: string,
		name: string,
		params: ServerFromNameParams = {},
	): Promise<Server> {
		return await Server.fromName(appName, name, params);
	}

	/**
	 * @description Internal object ID for the Server
	 */
	get objectId(): string {
		return this.#function.functionId;
	}

	get object_id(): string {
		return this.objectId;
	}

	/**
	 * @description Gets the Server URL
	 */
	async getUrl(): Promise<string | undefined> {
		return await this.#function.getWebUrl();
	}

	async get_url(): Promise<string | undefined> {
		return await this.getUrl();
	}

	/**
	 * @description Updates the Server autoscaler
	 */
	async updateAutoscaler(params: ServerUpdateAutoscalerParams): Promise<void> {
		const minContainers = aliasedNumber(
			params,
			"minContainers",
			"min_containers",
		);
		const maxContainers = aliasedNumber(
			params,
			"maxContainers",
			"max_containers",
		);
		const bufferContainers = aliasedNumber(
			params,
			"bufferContainers",
			"buffer_containers",
		);
		const targetConcurrency = aliasedNumber(
			params,
			"targetConcurrency",
			"target_concurrency",
		);
		await this.#function.updateAutoscaler({
			...(minContainers !== undefined && { minContainers }),
			...(maxContainers !== undefined && { maxContainers }),
			...(bufferContainers !== undefined && { bufferContainers }),
			...(params.scaledownWindowMs !== undefined && {
				scaledownWindowMs: params.scaledownWindowMs,
			}),
			...(params.scaleupWindowMs !== undefined && {
				scaleupWindowMs: params.scaleupWindowMs,
			}),
			...(targetConcurrency !== undefined && { targetConcurrency }),
			...(params.scaleup_window !== undefined && {
				scaleup_window: params.scaleup_window,
			}),
			...(params.scaleup_window_ms !== undefined && {
				scaleup_window_ms: params.scaleup_window_ms,
			}),
			...(params.scaledown_window !== undefined && {
				scaledown_window: params.scaledown_window,
			}),
			...(params.scaledown_window_ms !== undefined && {
				scaledown_window_ms: params.scaledown_window_ms,
			}),
		});
	}

	async update_autoscaler(params: ServerUpdateAutoscalerParams): Promise<void> {
		await this.updateAutoscaler(params);
	}

	async hydrate(): Promise<Server> {
		return this;
	}
}

/**
 * @description Service for managing Servers
 */
export class ServerService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Looks up a Server inside an App by name
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

	async from_name(
		appName: string,
		name: string,
		params: Omit<ServerFromNameParams, "client"> = {},
	): Promise<Server> {
		return await this.fromName(appName, name, params);
	}
}
