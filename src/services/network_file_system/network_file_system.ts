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
import { aliasedBoolean, environmentParam } from "@/utils/param_aliases";

/**
 * @description Optional parameters for {@link NetworkFileSystemService#fromName client.networkFileSystems.fromName()}
 * @property environment - Environment name to use
 * @property createIfMissing - Whether to create automatically when missing
 */
export type NetworkFileSystemFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	createIfMissing?: boolean;
	create_if_missing?: boolean;
};

/**
 * @description Optional parameters for {@link NetworkFileSystemService#create client.networkFileSystems.create()}
 * @property environment - Environment name to use
 * @property allowExisting - Whether to treat an existing NetworkFileSystem as success
 */
export type NetworkFileSystemCreateParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowExisting?: boolean;
	allow_existing?: boolean;
};

/**
 * @description Optional parameters for {@link NetworkFileSystemService#list client.networkFileSystems.list()}
 * @property environment - Environment name to use
 */
export type NetworkFileSystemListParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * @description Optional parameters for {@link NetworkFileSystemService#delete client.networkFileSystems.delete()}
 * @property environment - Environment name to use
 * @property allowMissing - Whether to suppress errors when the NetworkFileSystem does not exist
 */
export type NetworkFileSystemDeleteParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowMissing?: boolean;
	allow_missing?: boolean;
};

/**
 * @description Optional parameters for {@link NetworkFileSystemService#ephemeral client.networkFileSystems.ephemeral()}
 * @property environment - Environment name to use
 */
export type NetworkFileSystemEphemeralParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * @description File entry for NetworkFileSystem
 */
export type NetworkFileSystemFileEntry = {
	path: string;
	type: number;
	mtime: number;
	size: number;
};

/**
 * @description Service for managing deprecated NetworkFileSystem objects
 */
export class NetworkFileSystemService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Creates a named NetworkFileSystem
	 */
	async create(
		name: string,
		params: NetworkFileSystemCreateParams = {},
	): Promise<void> {
		await this.#client.cpClient.sharedVolumeGetOrCreate({
			deploymentName: name,
			environmentName: this.#client.environmentName(environmentParam(params)),
			objectCreationType: aliasedBoolean(
				params,
				"allowExisting",
				"allow_existing",
			)
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS,
		});
	}

	/**
	 * @description Creates an unnamed ephemeral NetworkFileSystem
	 */
	async ephemeral(
		params: NetworkFileSystemEphemeralParams = {},
	): Promise<NetworkFileSystem> {
		const resp = await this.#client.cpClient.sharedVolumeGetOrCreate({
			environmentName: this.#client.environmentName(environmentParam(params)),
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
	 * @description Looks up a NetworkFileSystem by name
	 */
	async fromName(
		name: string,
		params: NetworkFileSystemFromNameParams = {},
	): Promise<NetworkFileSystem> {
		try {
			const resp = await this.#client.cpClient.sharedVolumeGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(environmentParam(params)),
				objectCreationType: aliasedBoolean(
					params,
					"createIfMissing",
					"create_if_missing",
				)
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
	): Promise<NetworkFileSystem> {
		await this.create(name, params);
		const environment = environmentParam(params);
		return await this.fromName(name, {
			...(environment !== undefined && { environment }),
			createIfMissing: false,
		});
	}

	/**
	 * @description Lists named NetworkFileSystems
	 */
	async list(
		params: NetworkFileSystemListParams = {},
	): Promise<NetworkFileSystem[]> {
		const resp = await this.#client.cpClient.sharedVolumeList({
			environmentName: this.#client.environmentName(environmentParam(params)),
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
	 * @description Deletes a named NetworkFileSystem
	 */
	async delete(
		name: string,
		params: NetworkFileSystemDeleteParams = {},
	): Promise<void> {
		try {
			const environment = environmentParam(params);
			const nfs = await this.fromName(name, {
				...(environment !== undefined && { environment }),
			});
			await this.#client.cpClient.sharedVolumeDelete({
				sharedVolumeId: nfs.networkFileSystemId,
			});
		} catch (err) {
			suppressNotFound(
				err,
				aliasedBoolean(params, "allowMissing", "allow_missing"),
			);
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

	static async ephemeral(
		params: NetworkFileSystemEphemeralParams = {},
	): Promise<NetworkFileSystem> {
		return await getDefaultClient().networkFileSystems.ephemeral(params);
	}

	static async create_deployed(
		name: string,
		params: NetworkFileSystemCreateParams = {},
	): Promise<NetworkFileSystem> {
		return await getDefaultClient().networkFileSystems.create_deployed(
			name,
			params,
		);
	}

	static async createDeployed(
		name: string,
		params: NetworkFileSystemCreateParams = {},
	): Promise<NetworkFileSystem> {
		return await NetworkFileSystem.create_deployed(name, params);
	}

	static async delete(
		name: string,
		params: NetworkFileSystemDeleteParams = {},
	): Promise<void> {
		await getDefaultClient().networkFileSystems.delete(name, params);
	}

	static async from_name(
		name: string,
		params: NetworkFileSystemFromNameParams = {},
	): Promise<NetworkFileSystem> {
		return await getDefaultClient().networkFileSystems.fromName(name, params);
	}

	static async fromName(
		name: string,
		params: NetworkFileSystemFromNameParams = {},
	): Promise<NetworkFileSystem> {
		return await NetworkFileSystem.from_name(name, params);
	}

	/**
	 * @description Stops the heartbeat for an ephemeral NetworkFileSystem
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("NetworkFileSystem is not ephemeral.");
		}
	}

	/**
	 * @description Writes a file
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
	 * @description Adds a local file to the NetworkFileSystem
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
	 * @description Recursively adds a local directory to the NetworkFileSystem
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
	 * @description Reads a file
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
	 * @description Iterates file entries under a path
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
	 * @description Returns the list of file entries under a path
	 */
	async listdir(path: string): Promise<NetworkFileSystemFileEntry[]> {
		const entries: NetworkFileSystemFileEntry[] = [];
		for await (const entry of this.iterdir(path)) entries.push(entry);
		return entries;
	}

	/**
	 * @description Removes a file
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
