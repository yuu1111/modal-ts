import { getDefaultClient, type ModalClient } from "@/core/client";

/**
 * @description SandboxSnapshot.fromId() のオプションパラメータ
 */
export type SandboxSnapshotFromIdParams = {
	client?: ModalClient;
};

/**
 * @description Modal Sandbox snapshot
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
	 * @description 既存 snapshot ID から handle を作る
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
	 * @description snapshot ID をサーバーへ問い合わせて検証する
	 */
	async hydrate(): Promise<SandboxSnapshot> {
		const client = this.#client ?? getDefaultClient();
		const resp = await client.cpClient.sandboxSnapshotGet({
			snapshotId: this.snapshotId,
		});
		return new SandboxSnapshot(resp.snapshotId, client);
	}
}
