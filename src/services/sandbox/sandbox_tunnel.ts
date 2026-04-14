import { InvalidError } from "@/core/errors";

/**
 * @description Sandbox.createConnectToken()のオプションパラメータ
 * @property userMetadata - プロキシが Sandbox へリクエスト転送時にヘッダーに追加するメタデータ @optional
 */
export type SandboxCreateConnectTokenParams = {
	userMetadata?: string;
};

/**
 * @description Sandbox.createConnectToken()が返す接続情報
 * @property url - 接続先 URL
 * @property token - 認証トークン
 */
export type SandboxCreateConnectCredentials = {
	url: string;
	token: string;
};

/**
 * @description 実行中の {@link Sandbox} からフォワードされたポート
 */
export class Tunnel {
	/** @internal */
	constructor(
		public host: string,
		public port: number,
		public unencryptedHost?: string,
		public unencryptedPort?: number,
	) {}

	/**
	 * @description フォワードされたポートの公開 HTTPS URL を取得する
	 */
	get url(): string {
		let value = `https://${this.host}`;
		if (this.port !== 443) {
			value += `:${this.port}`;
		}
		return value;
	}

	/**
	 * @description 公開 TLS ソケットを [host, port] タプルで取得する
	 */
	get tlsSocket(): [string, number] {
		return [this.host, this.port];
	}

	/**
	 * @description 公開 TCP ソケットを [host, port] タプルで取得する
	 */
	get tcpSocket(): [string, number] {
		if (!this.unencryptedHost || this.unencryptedPort === undefined) {
			throw new InvalidError(
				"This tunnel is not configured for unencrypted TCP.",
			);
		}
		return [this.unencryptedHost, this.unencryptedPort];
	}
}
