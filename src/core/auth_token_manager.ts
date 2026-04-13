import type { Logger } from "@/utils/logger";

/**
 * @description AuthTokenManagerが使用するgRPCクライアントの最小インターフェース
 */
export interface AuthClient {
	authTokenGet(request: Record<string, never>): Promise<{ token?: string }>;
}

/**
 * @description JWTトークンからexpクレーム(UNIX秒)を抽出する
 * @param token - JWTトークン文字列
 * @returns expクレームの値、取得できない場合はnull
 */
export function decodeJwtExp(token: string): number | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) {
			return null;
		}
		const rawPayload = parts[1];
		if (rawPayload === undefined) {
			return null;
		}
		const padding = "=".repeat((4 - (rawPayload.length % 4)) % 4);
		const decoded = Buffer.from(rawPayload + padding, "base64").toString(
			"utf8",
		);
		const claims: Record<string, unknown> = JSON.parse(decoded);
		return typeof claims.exp === "number" ? claims.exp : null;
	} catch {
		return null;
	}
}

/**
 * @description トークン有効期限の何秒前からリフレッシュを開始するか
 */
export const REFRESH_WINDOW = 5 * 60;
/**
 * @description expクレームがない場合のデフォルト有効期間(秒)
 */
export const DEFAULT_EXPIRY_OFFSET = 20 * 60;

/**
 * @description 認証トークンの遅延リフレッシュ管理
 *
 * getToken呼び出し時にトークンの状態に応じて3つの動作をとる:
 *  1. 有効かつ期限に余裕あり: 即座に返却
 *  2. 未取得または期限切れ: 全呼び出し元が新トークン取得完了までブロック(取得は1回のみ)
 *  3. 有効だがREFRESH_WINDOW以内: リフレッシュ未実行なら呼び出し元がトリガー、
 *     他の並行呼び出し元には旧トークンを返却
 */
export class AuthTokenManager {
	private client: AuthClient;
	private logger: Logger;
	private currentToken: string = "";
	private tokenExpiry: number = 0;
	private refreshPromise: Promise<void> | null = null;

	constructor(client: AuthClient, logger: Logger) {
		this.client = client;
		this.logger = logger;
	}

	/**
	 * @description 有効な認証トークンを返す。必要に応じてリフレッシュを実行する
	 * @returns 認証トークン文字列
	 */
	async getToken(): Promise<string> {
		if (!this.currentToken || this.isExpired()) {
			return this.lockedRefreshToken();
		}

		if (this.needsRefresh() && !this.refreshPromise) {
			try {
				await this.lockedRefreshToken();
			} catch (error) {
				this.logger.error("refreshing auth token", "error", error);
			}
		}

		return this.currentToken;
	}

	/**
	 * @description 同時に1つだけトークン取得を実行する排他制御付きリフレッシュ
	 *
	 * 並行呼び出し元は同一のPromiseをawaitする。
	 * 別の呼び出し元が既にリフレッシュ済みならRPCをスキップする。
	 * @returns 現在の認証トークン
	 */
	private async lockedRefreshToken(): Promise<string> {
		if (!this.refreshPromise) {
			this.refreshPromise = (async () => {
				try {
					if (this.currentToken && !this.needsRefresh()) {
						return;
					}
					await this.fetchToken();
				} finally {
					this.refreshPromise = null;
				}
			})();
		}
		await this.refreshPromise;
		return this.currentToken;
	}

	/**
	 * @description サーバーから新しい認証トークンを取得して保存する
	 */
	private async fetchToken(): Promise<void> {
		const response = await this.client.authTokenGet({});
		const token = response.token;

		if (!token) {
			throw new Error(
				"Internal error: did not receive auth token from server, please contact Modal support",
			);
		}

		this.currentToken = token;

		const exp = this.decodeJWT(token);
		if (exp > 0) {
			this.tokenExpiry = exp;
		} else {
			this.logger.warn("x-modal-auth-token does not contain exp field");
			// expクレームがない場合はデフォルトの有効期間を設定して続行
			this.tokenExpiry = Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_OFFSET;
		}

		const now = Math.floor(Date.now() / 1000);
		const expiresIn = this.tokenExpiry - now;
		const refreshIn = this.tokenExpiry - now - REFRESH_WINDOW;
		this.logger.debug(
			"Fetched auth token",
			"expires_in",
			`${expiresIn}s`,
			"refresh_in",
			`${refreshIn}s`,
		);
	}

	/**
	 * @description JWTのexpクレームを取得する(失敗時は0)
	 */
	private decodeJWT(token: string): number {
		return decodeJwtExp(token) ?? 0;
	}

	/**
	 * @description トークンが有効期限切れかどうかを判定する
	 * @returns 期限切れならtrue
	 */
	isExpired(): boolean {
		const now = Math.floor(Date.now() / 1000);
		return now >= this.tokenExpiry;
	}

	/**
	 * @description トークンがリフレッシュ対象(REFRESH_WINDOW以内)かを判定する
	 * @returns リフレッシュが必要ならtrue
	 */
	private needsRefresh(): boolean {
		const now = Math.floor(Date.now() / 1000);
		return now >= this.tokenExpiry - REFRESH_WINDOW;
	}

	/**
	 * @description 現在保持しているトークン文字列を返す
	 * @returns 認証トークン(未取得時は空文字列)
	 */
	getCurrentToken(): string {
		return this.currentToken;
	}

	/**
	 * @description トークンと有効期限を直接設定する
	 * @param token - 認証トークン文字列
	 * @param expiry - 有効期限(UNIX秒)
	 */
	setToken(token: string, expiry: number): void {
		this.currentToken = token;
		this.tokenExpiry = expiry;
	}
}
