import { getDefaultClient, type ModalClient } from "@/core/client";

/**
 * Optional parameters for SandboxSnapshot.fromId()
 */
export type SandboxSnapshotFromIdParams = {
	client?: ModalClient;
};

/**
 * Modal Sandbox snapshot
 */
export class SandboxSnapshot {
	readonly snapshotId: string;
	readonly #client?: ModalClient;

	/**
	 * @internal
	 */
	constructor(snapshotId: string, client?: ModalClient) {
		this.snapshotId = snapshotId;
		if (client !== undefined) this.#client = client;
	}

	/**
	 * Creates a handle from an existing snapshot ID
	 */
	static fromId(
		snapshotId: string,
		params: SandboxSnapshotFromIdParams = {},
	): SandboxSnapshot {
		return new SandboxSnapshot(snapshotId, params.client);
	}

	static from_id(
		snapshotId: string,
		params: SandboxSnapshotFromIdParams = {},
	): SandboxSnapshot {
		return SandboxSnapshot.fromId(snapshotId, params);
	}

	/**
	 * Queries the server to validate the snapshot ID
	 */
	async hydrate(): Promise<SandboxSnapshot> {
		const client = this.#client ?? getDefaultClient();
		const resp = await client.cpClient.sandboxSnapshotGet({
			snapshotId: this.snapshotId,
		});
		return new SandboxSnapshot(resp.snapshotId, client);
	}
}
