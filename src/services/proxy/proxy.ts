import type { ModalClient } from "@/core/client";
import { NotFoundError, rethrowNotFound } from "@/core/errors";
import type { ProxyGetResponse } from "@/generated/modal_proto/api";

/**
 * @description {@link Proxy} を管理するサービス
 */
export class ProxyService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 名前で {@link Proxy} を参照する
	 * @param name - Proxy の名前
	 * @param params - オプションパラメータ
	 * @returns Proxy インスタンス
	 * @throws NotFoundError 指定された Proxy が存在しない場合
	 */
	async fromName(name: string, params?: ProxyFromNameParams): Promise<Proxy> {
		let resp: ProxyGetResponse;
		try {
			resp = await this.#client.cpClient.proxyGet({
				name,
				environmentName: this.#client.environmentName(params?.environment),
			});
		} catch (err) {
			rethrowNotFound(err, `Proxy '${name}' not found`);
		}
		if (!resp.proxy?.proxyId) {
			throw new NotFoundError(`Proxy '${name}' not found`);
		}
		return new Proxy(resp.proxy.proxyId);
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

	/**
	 * @internal
	 */
	constructor(proxyId: string) {
		this.proxyId = proxyId;
	}
}
