import { getDefaultClient, type ModalClient } from "@/core/client";
import { NotFoundError } from "@/core/errors";
import { rethrowNotFound } from "@/core/grpc/errors";
import type { ProxyGetResponse } from "@/generated/modal_proto/api";
import { environmentParam } from "@/utils/param_aliases";

/**
 * Service for managing {@link Proxy}
 */
export class ProxyService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * Looks up a {@link Proxy} by name
	 * @param name - Proxy name
	 * @param params - Optional parameters
	 * @returns Proxy instance
	 * @throws NotFoundError when the specified Proxy does not exist
	 */
	async fromName(name: string, params?: ProxyFromNameParams): Promise<Proxy> {
		let resp: ProxyGetResponse;
		try {
			resp = await this.#client.cpClient.proxyGet({
				name,
				environmentName: this.#client.environmentName(environmentParam(params)),
			});
		} catch (err) {
			rethrowNotFound(err, `Proxy '${name}' not found`);
		}
		if (!resp.proxy?.proxyId) {
			throw new NotFoundError(`Proxy '${name}' not found`);
		}
		return new Proxy(resp.proxy.proxyId);
	}

	async from_name(name: string, params?: ProxyFromNameParams): Promise<Proxy> {
		return await this.fromName(name, params);
	}
}

/**
 * Optional parameters for {@link ProxyService#fromName client.proxies.fromName()}
 * @property environment - Modal environment name
 */
export type ProxyFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * Proxy that provides a static outbound IP address for Modal containers
 */
export class Proxy {
	readonly proxyId: string;

	/**
	 * @internal
	 */
	constructor(proxyId: string) {
		this.proxyId = proxyId;
	}

	static async from_name(
		name: string,
		params?: ProxyFromNameParams,
	): Promise<Proxy> {
		return await getDefaultClient().proxies.fromName(name, params);
	}

	static async fromName(
		name: string,
		params?: ProxyFromNameParams,
	): Promise<Proxy> {
		return await Proxy.from_name(name, params);
	}
}
