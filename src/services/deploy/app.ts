import { getDefaultClient, type ModalClient } from "@/core/client";
import { rethrowNotFound } from "@/core/grpc/errors";
import { GPUConfig, ObjectCreationType } from "@/generated/modal_proto/api";
import { aliasedBoolean, environmentParam } from "@/utils/param_aliases";

/**
 * @description Service for managing {@link App}
 *
 * Usually accessed only through the client:
 * ```typescript
 * const modal = new ModalClient();
 * const app = await modal.apps.fromName("my-app");
 * ```
 */
export class AppService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Looks up a deployed {@link App} by name and can create it when missing
	 * @param name - App name
	 * @param params - Optional parameters
	 * @returns App instance
	 * @throws NotFoundError when the specified App does not exist
	 */
	async fromName(name: string, params: AppFromNameParams = {}): Promise<App> {
		try {
			const resp = await this.#client.cpClient.appGetOrCreate({
				appName: name,
				environmentName: this.#client.environmentName(environmentParam(params)),
				objectCreationType: aliasedBoolean(
					params,
					"createIfMissing",
					"create_if_missing",
				)
					? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
					: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED,
			});
			this.#client.logger.debug(
				"Retrieved App",
				"app_id",
				resp.appId,
				"app_name",
				name,
			);
			return new App(
				resp.appId,
				name,
				this.#client.environmentName(environmentParam(params)),
			);
		} catch (err) {
			rethrowNotFound(err, `App '${name}' not found`);
		}
	}
}

/**
 * @description Optional parameters for {@link AppService#fromName client.apps.fromName()}
 */
export type AppFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	createIfMissing?: boolean;
	create_if_missing?: boolean;
};

/**
 * @description Parses a GPU settings string into a GPUConfig object
 * @param gpu - GPU string in "type" or "type:count" format, for example "T4" or "A100:2"
 * @returns GPUConfig object, or an empty config when no GPU is specified
 */
export function parseGpuConfig(gpu: string | undefined): GPUConfig {
	if (!gpu) {
		return GPUConfig.create({});
	}

	let gpuType = gpu;
	let count = 1;

	if (gpu.includes(":")) {
		const [type, countStr] = gpu.split(":", 2) as [string, string];
		gpuType = type;
		count = parseInt(countStr, 10);
		if (Number.isNaN(count) || count < 1) {
			throw new Error(
				`Invalid GPU count: ${countStr}. Value must be a positive integer.`,
			);
		}
	}

	return GPUConfig.create({
		count,
		gpuType: gpuType.toUpperCase(),
	});
}

/**
 * @description Represents a deployed Modal App
 */
export class App {
	readonly appId: string;
	readonly name?: string;
	readonly environmentName?: string;

	/**
	 * @internal
	 */
	constructor(appId: string, name?: string, environmentName?: string) {
		this.appId = appId;
		if (name !== undefined) this.name = name;
		if (environmentName !== undefined) this.environmentName = environmentName;
	}

	static async from_name(
		name: string,
		params: AppFromNameParams = {},
	): Promise<App> {
		return await getDefaultClient().apps.fromName(name, params);
	}

	static async fromName(
		name: string,
		params: AppFromNameParams = {},
	): Promise<App> {
		return await App.from_name(name, params);
	}
}
