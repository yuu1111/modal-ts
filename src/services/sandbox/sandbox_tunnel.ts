import { InvalidError } from "@/core/errors";

/**
 * Optional parameters for Sandbox.createConnectToken()
 * @property userMetadata - Metadata the proxy adds to headers when forwarding requests to the Sandbox
 */
export type SandboxCreateConnectTokenParams = {
	userMetadata?: string;
};

/**
 * Connection information returned by Sandbox.createConnectToken()
 * @property url - Destination URL
 * @property token - Auth token
 */
export type SandboxCreateConnectCredentials = {
	url: string;
	token: string;
};

/**
 * Port forwarded from a running {@link Sandbox}
 */
export class Tunnel {
	/** @internal */
	constructor(
		public host: string,
		public port: number,
		public unencryptedHost?: string,
		public unencryptedPort?: number,
	) {}

	get unencrypted_host(): string | undefined {
		return this.unencryptedHost;
	}

	get unencrypted_port(): number | undefined {
		return this.unencryptedPort;
	}

	/**
	 * Gets the public HTTPS URL for the forwarded port
	 */
	get url(): string {
		let value = `https://${this.host}`;
		if (this.port !== 443) {
			value += `:${this.port}`;
		}
		return value;
	}

	/**
	 * Gets the public TLS socket as a [host, port] tuple
	 */
	get tlsSocket(): [string, number] {
		return [this.host, this.port];
	}

	/**
	 * Python-compatible alias for {@link Tunnel#tlsSocket}
	 */
	get tls_socket(): [string, number] {
		return this.tlsSocket;
	}

	/**
	 * Gets the public TCP socket as a [host, port] tuple
	 */
	get tcpSocket(): [string, number] {
		if (!this.unencryptedHost || this.unencryptedPort === undefined) {
			throw new InvalidError(
				"This tunnel is not configured for unencrypted TCP.",
			);
		}
		return [this.unencryptedHost, this.unencryptedPort];
	}

	/**
	 * Python-compatible alias for {@link Tunnel#tcpSocket}
	 */
	get tcp_socket(): [string, number] {
		return this.tcpSocket;
	}
}
