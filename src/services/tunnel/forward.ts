import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import { TunnelType } from "@/generated/modal_proto/api";
import { Tunnel } from "@/services/sandbox/sandbox_tunnel";

/**
 * @description forward() のパラメータ
 * @property unencrypted - TCP の非暗号化ポートも公開する @optional
 * @property h2Enabled - TLS tunnel で HTTP/2 を有効にする @optional
 * @property client - 使用する ModalClient @optional
 */
export type ForwardParams = {
	unencrypted?: boolean;
	h2Enabled?: boolean;
	client?: ModalClient;
};

/**
 * @description Modal コンテナ内の port を公開 tunnel として forward する
 */
export async function forward<T>(
	port: number,
	callback: (tunnel: Tunnel) => Promise<T> | T,
	params: ForwardParams = {},
): Promise<T> {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new InvalidError(`Invalid port number ${port}`);
	}
	if (params.h2Enabled && params.unencrypted) {
		throw new InvalidError("h2Enabled can only be used with encrypted ports");
	}

	const client = params.client ?? getDefaultClient();
	const response = await client.cpClient.tunnelStart({
		port,
		unencrypted: params.unencrypted ?? false,
		tunnelType: params.h2Enabled
			? TunnelType.TUNNEL_TYPE_H2
			: TunnelType.TUNNEL_TYPE_UNSPECIFIED,
	});
	const tunnel = new Tunnel(
		response.host,
		response.port,
		response.unencryptedHost || undefined,
		response.unencryptedPort || undefined,
	);

	try {
		return await callback(tunnel);
	} finally {
		await client.cpClient.tunnelStop({ port });
	}
}
