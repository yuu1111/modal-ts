import type { ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import {
	type FileEntry,
	ObjectCreationType,
	type VolumeMetadata,
	type VolumeMount,
	type VolumePutFiles2Request_Block,
} from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";

const VOLUME_BLOCK_SIZE = 8 * 1024 * 1024;

/**
 * @description {@link VolumeService#fromName client.volumes.fromName()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property createIfMissing - 存在しない場合に自動作成するかどうか
 */
export type VolumeFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

export type VolumeCreateParams = {
	environment?: string;
	allowExisting?: boolean;
};

export type VolumeListParams = {
	environment?: string;
	maxObjects?: number;
	createdBefore?: number;
};

/**
 * @description {@link VolumeService#ephemeral client.volumes.ephemeral()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type VolumeEphemeralParams = {
	environment?: string;
};

/**
 * @description {@link VolumeService#delete client.volumes.delete()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowMissing - 存在しない場合にエラーを抑制するかどうか
 */
export type VolumeDeleteParams = {
	environment?: string;
	allowMissing?: boolean;
};

/**
 * @description Volume をマウントするときのオプション
 * @property readOnly - コンテナ内で読み取り専用にするか
 * @property subPath - Volume 内の一部ディレクトリだけをマウントするパス
 */
export type VolumeMountOptions = {
	readOnly?: boolean;
	subPath?: string;
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
	 * @description 名前で {@link Volume} を参照する
	 * @param name - Volume の名前
	 * @param params - オプションパラメータ
	 * @returns Volume インスタンス
	 */
	async fromName(name: string, params?: VolumeFromNameParams): Promise<Volume> {
		try {
			const resp = await this.#client.cpClient.volumeGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(params?.environment),
				objectCreationType: params?.createIfMissing
					? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
					: ObjectCreationType.OBJECT_CREATION_TYPE_UNSPECIFIED,
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

	async create(name: string, params: VolumeCreateParams = {}): Promise<void> {
		await this.#client.cpClient.volumeGetOrCreate({
			deploymentName: name,
			environmentName: this.#client.environmentName(params.environment),
			objectCreationType: params.allowExisting
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS,
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

	async list(params: VolumeListParams = {}): Promise<Volume[]> {
		if (params.maxObjects !== undefined && params.maxObjects < 0) {
			throw new InvalidError("maxObjects cannot be negative");
		}

		const volumes: Volume[] = [];
		let createdBefore = params.createdBefore ?? 0;
		while (
			params.maxObjects === undefined ||
			volumes.length < params.maxObjects
		) {
			const maxPageSize =
				params.maxObjects === undefined
					? 100
					: Math.min(100, params.maxObjects - volumes.length);
			const resp = await this.#client.cpClient.volumeList({
				environmentName: this.#client.environmentName(params.environment),
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
	 * @description 名前のない一時的な {@link Volume} を作成する。closeEphemeral() が呼ばれるかプロセスが終了するまで存続する
	 * @param params - オプションパラメータ
	 * @returns 一時的な Volume インスタンス
	 */
	async ephemeral(params: VolumeEphemeralParams = {}): Promise<Volume> {
		const resp = await this.#client.cpClient.volumeGetOrCreate({
			objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
			environmentName: this.#client.environmentName(params.environment),
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
	 * @description 名前付き {@link Volume} を削除する。削除は不可逆で、現在使用中の App にも影響する
	 * @param name - 削除する Volume の名前
	 * @param params - オプションパラメータ
	 */
	async delete(name: string, params?: VolumeDeleteParams): Promise<void> {
		try {
			const volume = await this.fromName(name, {
				...(params?.environment !== undefined && {
					environment: params.environment,
				}),
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
			suppressNotFound(err, params?.allowMissing);
		}
	}
}

/**
 * @description Modal {@link Function_ Function} にマウント可能な永続ストレージを提供する Volume
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
			else mountOptions = nameOrMountOptions;
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

	/**
	 * @description Volume を読み取り専用でマウントするよう設定する
	 * @returns 読み取り専用に設定された新しい Volume インスタンス
	 */
	readOnly(): Volume {
		return this.withMountOptions({ readOnly: true });
	}

	/**
	 * @description Volume のマウントオプションを設定する
	 * @param params - マウントオプション。未指定の項目は既存設定を引き継ぐ
	 * @returns マウントオプションが適用された新しい Volume インスタンス
	 */
	withMountOptions(params: VolumeMountOptions = {}): Volume {
		let subPath = this._mountOptions.subPath;
		if (params.subPath !== undefined) {
			subPath = params.subPath === "/" ? undefined : params.subPath;
		}

		const nextOptions = {
			readOnly: params.readOnly ?? this._mountOptions.readOnly,
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

	get isReadOnly(): boolean {
		return this._mountOptions.readOnly;
	}

	/**
	 * @description 一時的な Volume を削除する。一時的な Volume でのみ使用可能
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("Volume is not ephemeral.");
		}
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
				yield volumeFileEntryFromProto(entry);
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

	#requireClient(): ModalClient {
		if (!this.#client) {
			throw new InvalidError(
				"This Volume was constructed without a ModalClient and only supports mount options",
			);
		}
		return this.#client;
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
 * @description Volume のマウント設定から gRPC VolumeMount を構築する
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
	const info: VolumeInfo = {};
	const name = metadata?.name || fallbackName;
	const createdAt = metadata?.creationInfo?.createdAt || fallbackCreatedAt;
	const createdBy = metadata?.creationInfo?.createdBy;
	if (name) info.name = name;
	if (createdAt) info.createdAt = createdAt;
	if (createdBy) info.createdBy = createdBy;
	if (metadata?.version !== undefined) info.version = metadata.version;
	return info;
}

function volumeFileEntryFromProto(entry: FileEntry): VolumeFileEntry {
	return {
		path: entry.path,
		type: entry.type,
		mtime: entry.mtime,
		size: entry.size,
	};
}

function chunkBytes(data: Uint8Array, size: number): Uint8Array[] {
	if (data.length === 0) return [new Uint8Array()];
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < data.length; offset += size) {
		chunks.push(data.subarray(offset, offset + size));
	}
	return chunks;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
