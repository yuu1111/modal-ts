import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import type {
	VolumeMetadata,
	VolumeMount,
	VolumePutFiles2Request_Block,
} from "@/generated/modal_proto/api";
import { chunkBytes, concatBytes } from "@/utils/bytes";
import {
	closeEphemeralHeartbeat,
	EphemeralHeartbeatManager,
} from "@/utils/ephemeral";
import { resourceFileEntryFromProto } from "@/utils/file_entry";
import { resourceInfoFromMetadata } from "@/utils/metadata";
import {
	allowExistingObjectCreationType,
	createIfMissingObjectCreationType,
	ephemeralObjectCreationType,
} from "@/utils/object_creation";
import {
	hasListCapacity,
	listPageSize,
	resolveListPagination,
} from "@/utils/pagination";
import {
	aliasedBoolean,
	aliasedString,
	environmentParam,
} from "@/utils/param_aliases";
import { posixJoin } from "@/utils/path";

const VOLUME_BLOCK_SIZE = 8 * 1024 * 1024;

/**
 * Optional parameters for {@link VolumeService#fromName client.volumes.fromName()}
 * @property environment - Environment name to use
 * @property createIfMissing - Whether to create automatically when missing
 */
export type VolumeFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	createIfMissing?: boolean;
	create_if_missing?: boolean;
};

export type VolumeCreateParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowExisting?: boolean;
	allow_existing?: boolean;
};

export type VolumeListParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	maxObjects?: number;
	max_objects?: number;
	createdBefore?: number;
	created_before?: number;
};

/**
 * Optional parameters for {@link VolumeService#ephemeral client.volumes.ephemeral()}
 * @property environment - Environment name to use
 */
export type VolumeEphemeralParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * Optional parameters for {@link VolumeService#delete client.volumes.delete()}
 * @property environment - Environment name to use
 * @property allowMissing - Whether to suppress errors when the Volume does not exist
 */
export type VolumeDeleteParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowMissing?: boolean;
	allow_missing?: boolean;
};

/**
 * Optional parameters for {@link VolumeService#rename client.volumes.rename()}
 * @property environment - Environment name to use
 */
export type VolumeRenameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * Options for mounting a Volume
 * @property readOnly - Whether to make it read-only inside the container
 * @property subPath - Path for mounting only part of the Volume
 */
export type VolumeMountOptions = {
	readOnly?: boolean;
	read_only?: boolean;
	subPath?: string;
	sub_path?: string;
};

type ResolvedMountOptions = {
	readOnly: boolean;
	subPath: string | undefined;
};

const DEFAULT_MOUNT_OPTIONS: ResolvedMountOptions = {
	readOnly: false,
	subPath: undefined,
};

/**
 * Service for managing {@link Volume}s.
 *
 * Normally only ever accessed via the client as:
 * ```typescript
 * const modal = new ModalClient();
 * const volume = await modal.volumes.fromName("my-volume");
 * ```
 */
export class VolumeService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * Looks up a {@link Volume} by name
	 * @param name - Volume name
	 * @param params - Optional parameters
	 * @returns Volume instance
	 */
	async fromName(name: string, params?: VolumeFromNameParams): Promise<Volume> {
		try {
			const resp = await this.#client.cpClient.volumeGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(environmentParam(params)),
				objectCreationType: createIfMissingObjectCreationType(params),
			});
			this.#client.logger.debug(
				"Retrieved Volume",
				"volume_id",
				resp.volumeId,
				"volume_name",
				name,
			);
			return new Volume(
				this.#client,
				resp.volumeId,
				name,
				undefined,
				undefined,
				volumeInfoFromMetadata(resp.metadata, name),
			);
		} catch (err) {
			rethrowNotFound(err);
		}
	}

	async from_name(
		name: string,
		params?: VolumeFromNameParams,
	): Promise<Volume> {
		return await this.fromName(name, params);
	}

	async create(name: string, params: VolumeCreateParams = {}): Promise<void> {
		await this.#client.cpClient.volumeGetOrCreate({
			deploymentName: name,
			environmentName: this.#client.environmentName(environmentParam(params)),
			objectCreationType: allowExistingObjectCreationType(params),
		});
	}

	async fromId(volumeId: string): Promise<Volume> {
		try {
			const resp = await this.#client.cpClient.volumeGetById({ volumeId });
			return new Volume(
				this.#client,
				volumeId,
				resp.metadata?.name || undefined,
				undefined,
				undefined,
				volumeInfoFromMetadata(resp.metadata),
			);
		} catch (err) {
			rethrowNotFound(err, `Volume with id: '${volumeId}' not found`);
		}
	}

	async from_id(volumeId: string): Promise<Volume> {
		return await this.fromId(volumeId);
	}

	async list(params: VolumeListParams = {}): Promise<Volume[]> {
		const pagination = resolveListPagination(params);
		const volumes: Volume[] = [];
		let createdBefore = pagination.createdBefore;
		while (hasListCapacity(pagination.maxObjects, volumes.length)) {
			const maxPageSize = listPageSize(pagination.maxObjects, volumes.length);
			const resp = await this.#client.cpClient.volumeList({
				environmentName: this.#client.environmentName(environmentParam(params)),
				pagination: { maxObjects: maxPageSize, createdBefore },
			});
			if (!resp.items || resp.items.length === 0) break;
			for (const item of resp.items) {
				volumes.push(
					new Volume(
						this.#client,
						item.volumeId,
						item.metadata?.name || item.label || undefined,
						undefined,
						undefined,
						volumeInfoFromMetadata(item.metadata, item.label, item.createdAt),
					),
				);
			}
			if (resp.items.length < maxPageSize) break;
			createdBefore =
				resp.items[resp.items.length - 1]?.metadata?.creationInfo?.createdAt ??
				resp.items[resp.items.length - 1]?.createdAt ??
				0;
		}

		return volumes;
	}

	/**
	 * Creates an unnamed ephemeral {@link Volume}. It lasts until closeEphemeral() is called or the process exits
	 * @param params - Optional parameters
	 * @returns Ephemeral Volume instance
	 */
	async ephemeral(params: VolumeEphemeralParams = {}): Promise<Volume> {
		const resp = await this.#client.cpClient.volumeGetOrCreate({
			objectCreationType: ephemeralObjectCreationType,
			environmentName: this.#client.environmentName(environmentParam(params)),
		});

		this.#client.logger.debug(
			"Created ephemeral Volume",
			"volume_id",
			resp.volumeId,
		);

		const ephemeralHbManager = new EphemeralHeartbeatManager(() =>
			this.#client.cpClient.volumeHeartbeat({ volumeId: resp.volumeId }),
		);

		return new Volume(
			this.#client,
			resp.volumeId,
			undefined,
			false,
			ephemeralHbManager,
		);
	}

	/**
	 * Deletes a named {@link Volume}. Deletion is irreversible and affects any App currently using it
	 * @param name - Name of the Volume to delete
	 * @param params - Optional parameters
	 */
	async delete(name: string, params?: VolumeDeleteParams): Promise<void> {
		try {
			const environment = environmentParam(params);
			const volume = await this.fromName(name, {
				...(environment !== undefined && { environment }),
				createIfMissing: false,
			});
			await this.#client.cpClient.volumeDelete({
				volumeId: volume.volumeId,
			});
			this.#client.logger.debug(
				"Deleted Volume",
				"volume_name",
				name,
				"volume_id",
				volume.volumeId,
			);
		} catch (err) {
			suppressNotFound(
				err,
				aliasedBoolean(params, "allowMissing", "allow_missing"),
			);
		}
	}

	/**
	 * Renames a named {@link Volume}
	 * @param oldName - Previous Volume name
	 * @param newName - New Volume name
	 * @param params - Optional parameters
	 */
	async rename(
		oldName: string,
		newName: string,
		params: VolumeRenameParams = {},
	): Promise<void> {
		const environment = environmentParam(params);
		const volume = await this.fromName(oldName, {
			...(environment !== undefined && { environment }),
			createIfMissing: false,
		});
		await this.#client.cpClient.volumeRename({
			volumeId: volume.volumeId,
			name: newName,
		});
	}
}

/**
 * Volume providing persistent storage that can be mounted on a Modal {@link Function_ Function}
 */
export class Volume {
	readonly #client?: ModalClient;
	readonly volumeId: string;
	readonly name?: string;
	readonly #info?: VolumeInfo;
	/**
	 * @internal
	 */
	readonly _mountOptions: ResolvedMountOptions = DEFAULT_MOUNT_OPTIONS;
	readonly #ephemeralHbManager?: EphemeralHeartbeatManager;

	/** @internal */
	constructor(
		clientOrVolumeId: ModalClient | string,
		volumeIdOrName?: string,
		nameOrMountOptions?: string | ResolvedMountOptions | boolean,
		mountOptions?: ResolvedMountOptions | boolean,
		ephemeralHbManager?: EphemeralHeartbeatManager,
		info?: VolumeInfo,
	) {
		if (typeof clientOrVolumeId === "string") {
			this.volumeId = clientOrVolumeId;
			if (volumeIdOrName !== undefined) this.name = volumeIdOrName;
			mountOptions = nameOrMountOptions as
				| ResolvedMountOptions
				| boolean
				| undefined;
		} else {
			this.#client = clientOrVolumeId;
			this.volumeId = volumeIdOrName as string;
			if (typeof nameOrMountOptions === "string")
				this.name = nameOrMountOptions;
			else if (nameOrMountOptions !== undefined)
				mountOptions = nameOrMountOptions;
		}
		if (info !== undefined) this.#info = info;
		if (typeof mountOptions === "boolean") {
			this._mountOptions = {
				...DEFAULT_MOUNT_OPTIONS,
				readOnly: mountOptions,
			};
		} else if (mountOptions !== undefined) {
			this._mountOptions = mountOptions;
		}
		if (ephemeralHbManager !== undefined)
			this.#ephemeralHbManager = ephemeralHbManager;
	}

	static get objects(): VolumeService {
		return getDefaultClient().volumes;
	}

	static async create(
		name: string,
		params: VolumeCreateParams = {},
	): Promise<void> {
		await getDefaultClient().volumes.create(name, params);
	}

	static async list(params: VolumeListParams = {}): Promise<Volume[]> {
		return await getDefaultClient().volumes.list(params);
	}

	static async delete(
		name: string,
		params?: VolumeDeleteParams,
	): Promise<void> {
		await getDefaultClient().volumes.delete(name, params);
	}

	static async ephemeral(params: VolumeEphemeralParams = {}): Promise<Volume> {
		return await getDefaultClient().volumes.ephemeral(params);
	}

	static async from_name(
		name: string,
		params?: VolumeFromNameParams,
	): Promise<Volume> {
		return await getDefaultClient().volumes.fromName(name, params);
	}

	static async fromName(
		name: string,
		params?: VolumeFromNameParams,
	): Promise<Volume> {
		return await Volume.from_name(name, params);
	}

	static async from_id(volumeId: string): Promise<Volume> {
		return await getDefaultClient().volumes.fromId(volumeId);
	}

	static async fromId(volumeId: string): Promise<Volume> {
		return await Volume.from_id(volumeId);
	}

	static async rename(
		oldName: string,
		newName: string,
		params: VolumeRenameParams = {},
	): Promise<void> {
		await getDefaultClient().volumes.rename(oldName, newName, params);
	}

	/**
	 * Configures the Volume to mount as read-only
	 * @returns New Volume instance configured as read-only
	 */
	readOnly(): Volume {
		return this.withMountOptions({ readOnly: true });
	}

	read_only(): Volume {
		return this.readOnly();
	}

	/**
	 * Sets mount options for the Volume
	 * @param params - Mount options. Omitted fields keep the existing settings
	 * @returns New Volume instance with mount options applied
	 */
	withMountOptions(params: VolumeMountOptions = {}): Volume {
		let subPath = this._mountOptions.subPath;
		const nextSubPath = aliasedString(params, "subPath", "sub_path");
		if (nextSubPath !== undefined) {
			subPath = nextSubPath === "/" ? undefined : nextSubPath;
		}
		const readOnly = aliasedBoolean(params, "readOnly", "read_only");

		const nextOptions = {
			readOnly: readOnly ?? this._mountOptions.readOnly,
			subPath,
		};
		return this.#client
			? new Volume(
					this.#client,
					this.volumeId,
					this.name,
					nextOptions,
					this.#ephemeralHbManager,
					this.#info,
				)
			: new Volume(this.volumeId, this.name, nextOptions);
	}

	with_mount_options(params: VolumeMountOptions = {}): Volume {
		return this.withMountOptions(params);
	}

	get isReadOnly(): boolean {
		return this._mountOptions.readOnly;
	}

	/**
	 * Deletes an ephemeral Volume. Only available for ephemeral Volumes
	 */
	closeEphemeral(): void {
		closeEphemeralHeartbeat(this.#ephemeralHbManager, "Volume");
	}

	info(): VolumeInfo {
		return this.#info ?? volumeInfoFromMetadata(undefined, this.name);
	}

	async commit(): Promise<void> {
		const client = this.#requireClient();
		await client.cpClient.volumeCommit({ volumeId: this.volumeId });
	}

	async reload(): Promise<void> {
		const client = this.#requireClient();
		await client.cpClient.volumeReload({ volumeId: this.volumeId });
	}

	async copyFiles(
		srcPaths: string[],
		dstPath: string,
		params: { recursive?: boolean } = {},
	): Promise<void> {
		const client = this.#requireClient();
		await client.cpClient.volumeCopyFiles2({
			volumeId: this.volumeId,
			srcPaths,
			dstPath,
			recursive: params.recursive ?? false,
		});
	}

	async copy_files(
		srcPaths: string[],
		dstPath: string,
		params: { recursive?: boolean } = {},
	): Promise<void> {
		await this.copyFiles(srcPaths, dstPath, params);
	}

	async removeFile(
		path: string,
		params: { recursive?: boolean } = {},
	): Promise<void> {
		const client = this.#requireClient();
		await client.cpClient.volumeRemoveFile2({
			volumeId: this.volumeId,
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

	async *iterdir(
		path = "/",
		params: { recursive?: boolean; maxEntries?: number } = {},
	): AsyncGenerator<VolumeFileEntry, void, unknown> {
		const client = this.#requireClient();
		for await (const resp of client.cpClient.volumeListFiles2({
			volumeId: this.volumeId,
			path,
			recursive: params.recursive ?? false,
			...(params.maxEntries !== undefined && { maxEntries: params.maxEntries }),
		})) {
			for (const entry of resp.entries ?? []) {
				yield resourceFileEntryFromProto<VolumeFileEntry>(entry);
			}
		}
	}

	async listdir(
		path = "/",
		params: { recursive?: boolean; maxEntries?: number } = {},
	): Promise<VolumeFileEntry[]> {
		const entries: VolumeFileEntry[] = [];
		for await (const entry of this.iterdir(path, params)) entries.push(entry);
		return entries;
	}

	async readFile(
		path: string,
		params: { start?: number; length?: number } = {},
	): Promise<Uint8Array> {
		const client = this.#requireClient();
		const resp = await client.cpClient.volumeGetFile2({
			volumeId: this.volumeId,
			path,
			start: params.start ?? 0,
			len: params.length ?? 0,
		});
		const chunks: Uint8Array[] = [];
		for (const url of resp.getUrls ?? []) {
			const httpResp = await fetch(url);
			if (!httpResp.ok) {
				throw new Error(`Volume file download failed with ${httpResp.status}`);
			}
			chunks.push(new Uint8Array(await httpResp.arrayBuffer()));
		}
		return concatBytes(chunks);
	}

	async read_file(
		path: string,
		params: { start?: number; length?: number } = {},
	): Promise<Uint8Array> {
		return await this.readFile(path, params);
	}

	async read_file_into_fileobj(
		path: string,
		fileobj: { write(chunk: Uint8Array): unknown },
		params: { start?: number; length?: number } = {},
	): Promise<number> {
		const data = await this.readFile(path, params);
		await fileobj.write(data);
		return data.length;
	}

	async readFileIntoFileobj(
		path: string,
		fileobj: { write(chunk: Uint8Array): unknown },
		params: { start?: number; length?: number } = {},
	): Promise<number> {
		return await this.read_file_into_fileobj(path, fileobj, params);
	}

	async writeBytes(
		path: string,
		data: Uint8Array,
		params: { mode?: number; overwrite?: boolean } = {},
	): Promise<void> {
		const client = this.#requireClient();
		const blocks: VolumePutFiles2Request_Block[] = await Promise.all(
			chunkBytes(data, VOLUME_BLOCK_SIZE).map(async (chunk) => ({
				contentsSha256: new Uint8Array(
					await crypto.subtle.digest("SHA-256", chunk),
				),
			})),
		);
		let resp = await client.cpClient.volumePutFiles2({
			volumeId: this.volumeId,
			disallowOverwriteExistingFiles: params.overwrite === false,
			files: [{ path, size: data.length, blocks, mode: params.mode }],
		});

		if (resp.missingBlocks.length === 0) return;

		const uploadedBlocks = blocks.map((block) => ({ ...block }));
		const chunks = chunkBytes(data, VOLUME_BLOCK_SIZE);
		for (const missing of resp.missingBlocks) {
			const chunk = chunks[missing.blockIndex];
			if (!chunk) throw new Error("Volume upload requested an unknown block");
			const putResp = await fetch(missing.putUrl, {
				method: "PUT",
				body: chunk,
			});
			if (!putResp.ok) {
				throw new Error(`Volume block upload failed with ${putResp.status}`);
			}
			const block = uploadedBlocks[missing.blockIndex];
			if (!block) throw new Error("Volume upload requested an unknown block");
			uploadedBlocks[missing.blockIndex] = {
				...block,
				putResponse: new Uint8Array(await putResp.arrayBuffer()),
			};
		}

		resp = await client.cpClient.volumePutFiles2({
			volumeId: this.volumeId,
			disallowOverwriteExistingFiles: params.overwrite === false,
			files: [
				{ path, size: data.length, blocks: uploadedBlocks, mode: params.mode },
			],
		});
		if (resp.missingBlocks.length > 0) {
			throw new Error("Volume upload did not complete after uploading blocks");
		}
	}

	async writeText(
		path: string,
		data: string,
		params: { mode?: number; overwrite?: boolean } = {},
	): Promise<void> {
		await this.writeBytes(path, new TextEncoder().encode(data), params);
	}

	batchUpload(params: { force?: boolean } = {}): VolumeBatchUpload {
		return new VolumeBatchUpload(this, params.force ?? false);
	}

	batch_upload(params: { force?: boolean } = {}): VolumeBatchUpload {
		return this.batchUpload(params);
	}

	#requireClient(): ModalClient {
		if (!this.#client) {
			throw new InvalidError(
				"This Volume was constructed without a ModalClient and only supports mount options",
			);
		}
		return this.#client;
	}
}

/**
 * Volume batch upload helper
 */
export class VolumeBatchUpload {
	readonly #volume: Volume;
	readonly #force: boolean;
	#tasks: Array<Promise<void>> = [];

	constructor(volume: Volume, force: boolean) {
		this.#volume = volume;
		this.#force = force;
	}

	putFile(
		localPath: string,
		remotePath: string,
		params: { mode?: number } = {},
	): void {
		this.#tasks.push(
			readFile(localPath).then((data) =>
				this.#volume.writeBytes(remotePath, data, {
					...params,
					overwrite: this.#force,
				}),
			),
		);
	}

	put_file(
		localPath: string,
		remotePath: string,
		params: { mode?: number } = {},
	): void {
		this.putFile(localPath, remotePath, params);
	}

	putBytes(
		data: Uint8Array,
		remotePath: string,
		params: { mode?: number } = {},
	): void {
		this.#tasks.push(
			this.#volume.writeBytes(remotePath, data, {
				...params,
				overwrite: this.#force,
			}),
		);
	}

	put_bytes(
		data: Uint8Array,
		remotePath: string,
		params: { mode?: number } = {},
	): void {
		this.putBytes(data, remotePath, params);
	}

	async putDirectory(
		localPath: string,
		remotePath: string,
		params: { recursive?: boolean; mode?: number } = {},
	): Promise<void> {
		const recursive = params.recursive ?? true;
		for (const entry of await readdir(localPath, { withFileTypes: true })) {
			const localEntry = path.join(localPath, entry.name);
			const remoteEntry = posixJoin(remotePath, entry.name);
			if (entry.isDirectory()) {
				if (recursive) {
					await this.putDirectory(localEntry, remoteEntry, params);
				}
			} else if (entry.isFile()) {
				this.putFile(localEntry, remoteEntry, params);
			}
		}
	}

	async put_directory(
		localPath: string,
		remotePath: string,
		params: { recursive?: boolean; mode?: number } = {},
	): Promise<void> {
		await this.putDirectory(localPath, remotePath, params);
	}

	async done(): Promise<void> {
		await Promise.all(this.#tasks);
		this.#tasks = [];
	}
}

export type VolumeInfo = {
	name?: string;
	createdAt?: number;
	createdBy?: string;
	version?: number;
};

export type VolumeFileEntry = {
	path: string;
	type: number;
	mtime: number;
	size: number;
};

/**
 * Builds a gRPC VolumeMount from Volume mount settings
 * @internal
 */
export function volumeToMountProto(
	mountPath: string,
	volume: Volume,
): VolumeMount {
	const opts = volume._mountOptions ?? DEFAULT_MOUNT_OPTIONS;
	return {
		volumeId: volume.volumeId,
		mountPath,
		allowBackgroundCommits: true,
		readOnly: opts.readOnly,
		subPath: opts.subPath,
	};
}

function volumeInfoFromMetadata(
	metadata?: VolumeMetadata,
	fallbackName?: string,
	fallbackCreatedAt?: number,
): VolumeInfo {
	const info = resourceInfoFromMetadata<VolumeInfo>(
		metadata,
		fallbackName,
		fallbackCreatedAt,
	);
	if (metadata?.version !== undefined) info.version = metadata.version;
	return info;
}
