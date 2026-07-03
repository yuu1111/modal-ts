import type { Logger } from "@/utils/logger";

/**
 * Minimal gRPC client interface used by AuthTokenManager
 */
export interface AuthClient {
	authTokenGet(request: Record<string, never>): Promise<{ token?: string }>;
}

/**
 * Returns the current time in Unix seconds
 */
function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Extracts the exp claim in Unix seconds from a JWT token
 * @param token - JWT token string
 * @returns exp claim value, or null when it cannot be read
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
 * Seconds before token expiry when refresh should begin
 */
export const REFRESH_WINDOW = 5 * 60;
/**
 * Default lifetime in seconds when the exp claim is missing
 */
export const DEFAULT_EXPIRY_OFFSET = 20 * 60;

/**
 * Lazy refresh manager for auth tokens
 *
 * getToken takes one of three paths based on token state:
 *  1. Valid with enough lifetime remaining: return immediately.
 *  2. Missing or expired: block all callers until a new token is fetched once.
 *  3. Valid but within REFRESH_WINDOW: trigger refresh if it has not started,
 *     and return the old token to other concurrent callers.
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
	 * Returns a valid auth token, refreshing it when needed
	 * @returns Auth token string
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
	 * Refresh with mutual exclusion so only one token fetch runs at a time
	 *
	 * Concurrent callers await the same Promise.
	 * If another caller already refreshed the token, the RPC is skipped.
	 * @returns Current auth token
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
	 * Fetches and stores a new auth token from the server
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

		const exp = decodeJwtExp(token);
		if (exp != null) {
			this.tokenExpiry = exp;
		} else {
			this.logger.warn("x-modal-auth-token does not contain exp field");
			// Continue with the default lifetime when the exp claim is missing.
			this.tokenExpiry = nowSeconds() + DEFAULT_EXPIRY_OFFSET;
		}

		const now = nowSeconds();
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
	 * Checks whether the token is expired
	 * @returns true when expired
	 */
	isExpired(): boolean {
		return nowSeconds() >= this.tokenExpiry;
	}

	/**
	 * Checks whether the token should be refreshed within REFRESH_WINDOW
	 * @returns true when refresh is needed
	 */
	private needsRefresh(): boolean {
		return nowSeconds() >= this.tokenExpiry - REFRESH_WINDOW;
	}

	/**
	 * Returns the currently stored token string
	 * @returns Auth token, or an empty string when no token has been fetched
	 */
	getCurrentToken(): string {
		return this.currentToken;
	}

	/**
	 * Directly sets the token and expiry
	 * @param token - Auth token string
	 * @param expiry - Expiry in Unix seconds
	 */
	setToken(token: string, expiry: number): void {
		this.currentToken = token;
		this.tokenExpiry = expiry;
	}
}
