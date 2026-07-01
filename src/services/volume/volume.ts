import type { ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import {
	ObjectCreationType,
	type VolumeMount,
} from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";

/**
 * @description {@link VolumeService#fromName client.volumes.fromName()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property createIfMissing - 存在しない場合に自動作成するかどうか
 */
export type VolumeFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
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
			return new Volume(resp.volumeId, name);
		} catch (err) {
			rethrowNotFound(err);
		}
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

		return new Volume(resp.volumeId, undefined, false, ephemeralHbManager);
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
	readonly volumeId: string;
	readonly name?: string;
	/**
	 * @internal
	 */
	readonly _mountOptions: ResolvedMountOptions = DEFAULT_MOUNT_OPTIONS;
	readonly #ephemeralHbManager?: EphemeralHeartbeatManager;

	/** @internal */
	constructor(
		volumeId: string,
		name?: string,
		mountOptions?: ResolvedMountOptions | boolean,
		ephemeralHbManager?: EphemeralHeartbeatManager,
	) {
		this.volumeId = volumeId;
		if (name !== undefined) this.name = name;
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

		return new Volume(
			this.volumeId,
			this.name,
			{
				readOnly: params.readOnly ?? this._mountOptions.readOnly,
				subPath,
			},
			this.#ephemeralHbManager,
		);
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
}

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
