import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import {
	type FileEntry,
	ObjectCreationType,
} from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";

/**
 * @description {@link NetworkFileSystemService#fromName client.networkFileSystems.fromName()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property createIfMissing - 存在しない場合に自動作成するかどうか
 */
export type NetworkFileSystemFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * @description {@link NetworkFileSystemService#create client.networkFileSystems.create()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowExisting - 既に存在する場合に成功として扱うか
 */
export type NetworkFileSystemCreateParams = {
	environment?: string;
	allowExisting?: boolean;
};

/**
 * @description {@link NetworkFileSystemService#list client.networkFileSystems.list()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type NetworkFileSystemListParams = {
	environment?: string;
};

/**
 * @description {@link NetworkFileSystemService#delete client.networkFileSystems.delete()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowMissing - 存在しない場合にエラーを抑制するかどうか
 */
export type NetworkFileSystemDeleteParams = {
	environment?: string;
	allowMissing?: boolean;
};

/**
 * @description {@link NetworkFileSystemService#ephemeral client.networkFileSystems.ephemeral()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type NetworkFileSystemEphemeralParams = {
	environment?: string;
};

/**
 * @description NetworkFileSystem の file entry
 */
export type NetworkFileSystemFileEntry = {
	path: string;
	type: number;
	mtime: number;
	size: number;
};

/**
 * @description deprecated NetworkFileSystem を管理するサービス
 */
export class NetworkFileSystemService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description 名前付き NetworkFileSystem を作成する
	 */
	async create(
		name: string,
		params: NetworkFileSystemCreateParams = {},
	): Promise<void> {
		await this.#client.cpClient.sharedVolumeGetOrCreate({
			deploymentName: name,
			environmentName: this.#client.environmentName(params.environment),
			objectCreationType: params.allowExisting
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS,
		});
	}

	/**
	 * @description 名前のない一時的な NetworkFileSystem を作成する
	 */
	async ephemeral(
		params: NetworkFileSystemEphemeralParams = {},
	): Promise<NetworkFileSystem> {
		const resp = await this.#client.cpClient.sharedVolumeGetOrCreate({
			environmentName: this.#client.environmentName(params.environment),
			objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
		});
		const ephemeralHbManager = new EphemeralHeartbeatManager(() =>
			this.#client.cpClient.sharedVolumeHeartbeat({
				sharedVolumeId: resp.sharedVolumeId,
			}),
		);
		return new NetworkFileSystem(
			this.#client,
			resp.sharedVolumeId,
			undefined,
			ephemeralHbManager,
		);
	}

	/**
	 * @description 名前で NetworkFileSystem を参照する
	 */
	async fromName(
		name: string,
		params: NetworkFileSystemFromNameParams = {},
	): Promise<NetworkFileSystem> {
		try {
			const resp = await this.#client.cpClient.sharedVolumeGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(params.environment),
				objectCreationType: params.createIfMissing
					? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
					: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED,
			});
			return new NetworkFileSystem(this.#client, resp.sharedVolumeId, name);
		} catch (err) {
			rethrowNotFound(err);
		}
	}

	async from_name(
		name: string,
		params: NetworkFileSystemFromNameParams = {},
	): Promise<NetworkFileSystem> {
		return await this.fromName(name, params);
	}

	async create_deployed(
		name: string,
		params: NetworkFileSystemCreateParams = {},
	): Promise<void> {
		await this.create(name, params);
	}

	/**
	 * @description 名前付き NetworkFileSystem の一覧を取得する
	 */
	async list(
		params: NetworkFileSystemListParams = {},
	): Promise<NetworkFileSystem[]> {
		const resp = await this.#client.cpClient.sharedVolumeList({
			environmentName: this.#client.environmentName(params.environment),
		});
		return (resp.items ?? []).map(
			(item) =>
				new NetworkFileSystem(
					this.#client,
					item.sharedVolumeId,
					item.label || undefined,
				),
		);
	}

	/**
	 * @description 名前付き NetworkFileSystem を削除する
	 */
	async delete(
		name: string,
		params: NetworkFileSystemDeleteParams = {},
	): Promise<void> {
		try {
			const nfs = await this.fromName(name, {
				...(params.environment !== undefined && {
					environment: params.environment,
				}),
			});
			await this.#client.cpClient.sharedVolumeDelete({
				sharedVolumeId: nfs.networkFileSystemId,
			});
		} catch (err) {
			suppressNotFound(err, params.allowMissing);
		}
	}
}

/**
 * @description deprecated shared writable filesystem
 */
export class NetworkFileSystem {
	readonly #client: ModalClient;
	readonly networkFileSystemId: string;
	readonly name?: string;
	readonly #ephemeralHbManager?: EphemeralHeartbeatManager;

	/** @internal */
	constructor(
		client: ModalClient,
		networkFileSystemId: string,
		name?: string,
		ephemeralHbManager?: EphemeralHeartbeatManager,
	) {
		this.#client = client;
		this.networkFileSystemId = networkFileSystemId;
		if (name !== undefined) this.name = name;
		if (ephemeralHbManager !== undefined)
			this.#ephemeralHbManager = ephemeralHbManager;
	}

	static async from_name(
		name: string,
		params: NetworkFileSystemFromNameParams = {},
	): Promise<NetworkFileSystem> {
		return await getDefaultClient().networkFileSystems.fromName(name, params);
	}

	/**
	 * @description 一時的な NetworkFileSystem の heartbeat を停止する
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("NetworkFileSystem is not ephemeral.");
		}
	}

	/**
	 * @description file を書き込む
	 */
	async writeFile(remotePath: string, data: Uint8Array): Promise<number> {
		const resp = await this.#client.cpClient.sharedVolumePutFile({
			sharedVolumeId: this.networkFileSystemId,
			path: remotePath,
			data,
			sha256Hex: await sha256Hex(data),
			resumable: true,
		});
		if (!resp.exists) {
			throw new Error(
				`NetworkFileSystem upload did not complete: ${remotePath}`,
			);
		}
		return data.length;
	}

	async write_file(remotePath: string, data: Uint8Array): Promise<number> {
		return await this.writeFile(remotePath, data);
	}

	/**
	 * @description local file を NetworkFileSystem に追加する
	 */
	async addLocalFile(localPath: string, remotePath?: string): Promise<number> {
		const data = await readFile(localPath);
		return await this.writeFile(remotePath ?? `/${basename(localPath)}`, data);
	}

	async add_local_file(
		localPath: string,
		remotePath?: string,
	): Promise<number> {
		return await this.addLocalFile(localPath, remotePath);
	}

	/**
	 * @description local directory を NetworkFileSystem に再帰的に追加する
	 */
	async addLocalDir(localPath: string, remotePath?: string): Promise<number> {
		const rootRemotePath = remotePath ?? `/${basename(localPath)}`;
		let totalBytes = 0;
		for await (const filePath of walkLocalFiles(localPath)) {
			const relativePath = path
				.relative(localPath, filePath)
				.replaceAll("\\", "/");
			totalBytes += await this.addLocalFile(
				filePath,
				posixJoin(rootRemotePath, relativePath),
			);
		}
		return totalBytes;
	}

	async add_local_dir(localPath: string, remotePath?: string): Promise<number> {
		return await this.addLocalDir(localPath, remotePath);
	}

	/**
	 * @description file を読み込む
	 */
	async readFile(path: string): Promise<Uint8Array> {
		const resp = await this.#client.cpClient.sharedVolumeGetFile({
			sharedVolumeId: this.networkFileSystemId,
			path,
		});
		if (resp.data !== undefined) return resp.data;
		if (resp.dataBlobId) {
			const blob = await this.#client.cpClient.blobGet({
				blobId: resp.dataBlobId,
			});
			const httpResp = await fetch(blob.downloadUrl);
			if (!httpResp.ok) {
				throw new Error(
					`NetworkFileSystem file download failed with ${httpResp.status}`,
				);
			}
			return new Uint8Array(await httpResp.arrayBuffer());
		}
		return new Uint8Array();
	}

	async read_file(path: string): Promise<Uint8Array> {
		return await this.readFile(path);
	}

	/**
	 * @description path 配下の file entry を iterate する
	 */
	async *iterdir(
		path: string,
	): AsyncGenerator<NetworkFileSystemFileEntry, void, unknown> {
		for await (const batch of this.#client.cpClient.sharedVolumeListFilesStream(
			{
				sharedVolumeId: this.networkFileSystemId,
				path,
			},
		)) {
			for (const entry of batch.entries ?? []) {
				yield networkFileSystemFileEntryFromProto(entry);
			}
		}
	}

	/**
	 * @description path 配下の file entry 一覧を返す
	 */
	async listdir(path: string): Promise<NetworkFileSystemFileEntry[]> {
		const entries: NetworkFileSystemFileEntry[] = [];
		for await (const entry of this.iterdir(path)) entries.push(entry);
		return entries;
	}

	/**
	 * @description file を削除する
	 */
	async removeFile(
		path: string,
		params: { recursive?: boolean } = {},
	): Promise<void> {
		await this.#client.cpClient.sharedVolumeRemoveFile({
			sharedVolumeId: this.networkFileSystemId,
			path,
			recursive: params.recursive ?? false,
		});
	}

	async remove_file(
		path: string,
		params: { recursive?: boolean } = {},
	): Promise<void> {
		await this.removeFile(path, params);
	}
}

function networkFileSystemFileEntryFromProto(
	entry: FileEntry,
): NetworkFileSystemFileEntry {
	return {
		path: entry.path,
		type: entry.type,
		mtime: entry.mtime,
		size: entry.size,
	};
}

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function basename(path: string): string {
	return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "file";
}

async function* walkLocalFiles(
	dir: string,
): AsyncGenerator<string, void, unknown> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkLocalFiles(entryPath);
		} else if (entry.isFile()) {
			yield entryPath;
		}
	}
}

function posixJoin(...parts: string[]): string {
	return `/${parts
		.join("/")
		.split("/")
		.filter((part) => part.length > 0)
		.join("/")}`;
}
