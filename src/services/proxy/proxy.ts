import type { ModalClient } from "@/core/client";
import { NotFoundError, rethrowNotFound } from "@/core/errors";

/**
 * Service for managing {@link Proxy Proxies}.
 */
export class ProxyService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * Reference a {@link Proxy} by its name.
	 *
	 * Normally only ever accessed via the client as:
	 * ```typescript
	 * const modal = new ModalClient();
	 * const proxy = await modal.proxies.fromName("my-proxy");
	 * ```
	 */
	async fromName(name: string, params?: ProxyFromNameParams): Promise<Proxy> {
		try {
			const resp = await this.#client.cpClient.proxyGet({
				name,
				environmentName: this.#client.environmentName(params?.environment),
			});
			if (!resp.proxy?.proxyId) {
				throw new NotFoundError(`Proxy '${name}' not found`);
			}
			return new Proxy(resp.proxy.proxyId);
		} catch (err) {
			rethrowNotFound(err, `Proxy '${name}' not found`);
		}
	}
}

/**
 * @description {@link ProxyService#fromName client.proxies.fromName()} のオプションパラメータ
 * @property environment - Modal環境名 @optional
 */
export type ProxyFromNameParams = {
	environment?: string;
};

/**
 * @description Modal コンテナに静的なアウトバウンド IP アドレスを提供するプロキシ
 */
export class Proxy {
	readonly proxyId: string;

	/** @internal */
	constructor(proxyId: string) {
		this.proxyId = proxyId;
	}
}
