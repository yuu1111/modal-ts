import type { ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import {
	CloudBucketMount_BucketType,
	CloudBucketMount as CloudBucketMountProto,
} from "@/generated/modal_proto/api";
import type { Secret } from "@/services/secret/secret";

/**
 * @description {@link CloudBucketMount} の作成を管理するサービス
 */
export class CloudBucketMountService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description クラウドバケットマウントを作成する
	 * @param bucketName - バケット名
	 * @param params - マウントオプション
	 * @returns 作成された CloudBucketMount
	 */
	create(
		bucketName: string,
		params: {
			secret?: Secret;
			readOnly?: boolean;
			requesterPays?: boolean;
			bucketEndpointUrl?: string;
			keyPrefix?: string;
			oidcAuthRoleArn?: string;
		} = {},
	): CloudBucketMount {
		let bucketType = CloudBucketMount_BucketType.S3;
		if (params.bucketEndpointUrl) {
			const url = new URL(params.bucketEndpointUrl);
			if (url.hostname.endsWith("r2.cloudflarestorage.com")) {
				bucketType = CloudBucketMount_BucketType.R2;
			} else if (url.hostname.endsWith("storage.googleapis.com")) {
				bucketType = CloudBucketMount_BucketType.GCP;
			} else {
				this.#client.logger.debug(
					"CloudBucketMount received unrecognized bucket endpoint URL. " +
						"Assuming AWS S3 configuration as fallback.",
					"bucketEndpointUrl",
					params.bucketEndpointUrl,
				);
			}
		}

		if (params.requesterPays && !params.secret) {
			throw new InvalidError(
				"Credentials required in order to use Requester Pays.",
			);
		}

		if (params.keyPrefix && !params.keyPrefix.endsWith("/")) {
			throw new InvalidError(
				"keyPrefix will be prefixed to all object paths, so it must end in a '/'",
			);
		}

		return new CloudBucketMount({
			bucketName,
			secret: params.secret,
			readOnly: params.readOnly ?? false,
			requesterPays: params.requesterPays ?? false,
			bucketEndpointUrl: params.bucketEndpointUrl,
			keyPrefix: params.keyPrefix,
			oidcAuthRoleArn: params.oidcAuthRoleArn,
			bucketType,
		});
	}
}

/**
 * @description Modal Function 内からクラウドストレージバケットにアクセスするためのマウント
 */
export class CloudBucketMount {
	readonly bucketName: string;
	readonly secret?: Secret;
	readonly readOnly: boolean;
	readonly requesterPays: boolean;
	readonly bucketEndpointUrl?: string;
	readonly keyPrefix?: string;
	readonly oidcAuthRoleArn?: string;
	readonly #bucketType: CloudBucketMount_BucketType;

	/** @internal */
	constructor(opts: {
		bucketName: string;
		secret: Secret | undefined;
		readOnly: boolean;
		requesterPays: boolean;
		bucketEndpointUrl: string | undefined;
		keyPrefix: string | undefined;
		oidcAuthRoleArn: string | undefined;
		bucketType: CloudBucketMount_BucketType;
	}) {
		this.bucketName = opts.bucketName;
		if (opts.secret !== undefined) this.secret = opts.secret;
		this.readOnly = opts.readOnly;
		this.requesterPays = opts.requesterPays;
		if (opts.bucketEndpointUrl !== undefined)
			this.bucketEndpointUrl = opts.bucketEndpointUrl;
		if (opts.keyPrefix !== undefined) this.keyPrefix = opts.keyPrefix;
		if (opts.oidcAuthRoleArn !== undefined)
			this.oidcAuthRoleArn = opts.oidcAuthRoleArn;
		this.#bucketType = opts.bucketType;
	}

	/** @internal */
	toProto(mountPath: string): CloudBucketMountProto {
		return CloudBucketMountProto.create({
			bucketName: this.bucketName,
			mountPath,
			credentialsSecretId: this.secret?.secretId ?? "",
			readOnly: this.readOnly,
			bucketType: this.#bucketType,
			requesterPays: this.requesterPays,
			bucketEndpointUrl: this.bucketEndpointUrl,
			keyPrefix: this.keyPrefix,
			oidcAuthRoleArn: this.oidcAuthRoleArn,
		});
	}
}
