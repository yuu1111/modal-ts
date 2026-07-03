import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import {
	CloudBucketMount_BucketType,
	CloudBucketMount as CloudBucketMountProto,
} from "@/generated/modal_proto/api";
import type { Secret } from "@/services/secret/secret";

export type CloudBucketMountCreateParams = {
	secret?: Secret;
	readOnly?: boolean;
	read_only?: boolean;
	requesterPays?: boolean;
	requester_pays?: boolean;
	bucketEndpointUrl?: string;
	bucket_endpoint_url?: string;
	keyPrefix?: string;
	key_prefix?: string;
	oidcAuthRoleArn?: string;
	oidc_auth_role_arn?: string;
	forcePathStyle?: boolean;
	force_path_style?: boolean;
};

/**
 * Service for managing creation of {@link CloudBucketMount}
 */
export class CloudBucketMountService {
	readonly #client: ModalClient;

	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * Creates a cloud bucket mount
	 * @param bucketName - Bucket name
	 * @param params - Mount options
	 * @returns Created CloudBucketMount
	 */
	create(
		bucketName: string,
		params: CloudBucketMountCreateParams = {},
	): CloudBucketMount {
		const bucketEndpointUrl =
			params.bucketEndpointUrl ?? params.bucket_endpoint_url;
		const requesterPays =
			params.requesterPays ?? params.requester_pays ?? false;
		const keyPrefix = params.keyPrefix ?? params.key_prefix;

		let bucketType = CloudBucketMount_BucketType.S3;
		if (bucketEndpointUrl) {
			const url = new URL(bucketEndpointUrl);
			if (url.hostname.endsWith("r2.cloudflarestorage.com")) {
				bucketType = CloudBucketMount_BucketType.R2;
			} else if (url.hostname.endsWith("storage.googleapis.com")) {
				bucketType = CloudBucketMount_BucketType.GCP;
			} else {
				this.#client.logger.debug(
					"CloudBucketMount received unrecognized bucket endpoint URL. " +
						"Assuming AWS S3 configuration as fallback.",
					"bucketEndpointUrl",
					bucketEndpointUrl,
				);
			}
		}

		if (requesterPays && !params.secret) {
			throw new InvalidError(
				"Credentials required in order to use Requester Pays.",
			);
		}

		if (keyPrefix && !keyPrefix.endsWith("/")) {
			throw new InvalidError(
				"keyPrefix will be prefixed to all object paths, so it must end in a '/'",
			);
		}

		return new CloudBucketMount({
			bucketName,
			secret: params.secret,
			readOnly: params.readOnly ?? params.read_only ?? false,
			requesterPays,
			bucketEndpointUrl,
			keyPrefix,
			oidcAuthRoleArn: params.oidcAuthRoleArn ?? params.oidc_auth_role_arn,
			forcePathStyle: params.forcePathStyle ?? params.force_path_style ?? false,
			bucketType,
		});
	}
}

/**
 * Mount for accessing a cloud storage bucket from inside a Modal Function
 */
export class CloudBucketMount {
	readonly bucketName: string;
	readonly secret?: Secret;
	readonly readOnly: boolean;
	readonly requesterPays: boolean;
	readonly bucketEndpointUrl?: string;
	readonly keyPrefix?: string;
	readonly oidcAuthRoleArn?: string;
	readonly forcePathStyle: boolean;
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
		forcePathStyle: boolean;
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
		this.forcePathStyle = opts.forcePathStyle;
		this.#bucketType = opts.bucketType;
	}

	static create(
		bucketName: string,
		params: CloudBucketMountCreateParams = {},
	): CloudBucketMount {
		return getDefaultClient().cloudBucketMounts.create(bucketName, params);
	}

	get bucket_name(): string {
		return this.bucketName;
	}

	get read_only(): boolean {
		return this.readOnly;
	}

	get requester_pays(): boolean {
		return this.requesterPays;
	}

	get bucket_endpoint_url(): string | undefined {
		return this.bucketEndpointUrl;
	}

	get key_prefix(): string | undefined {
		return this.keyPrefix;
	}

	get oidc_auth_role_arn(): string | undefined {
		return this.oidcAuthRoleArn;
	}

	get force_path_style(): boolean {
		return this.forcePathStyle;
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
			forcePathStyle: this.forcePathStyle,
		});
	}
}
