import { readFile } from "node:fs/promises";
import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError } from "@/core/errors";
import {
	rethrowInvalid,
	rethrowNotFound,
	suppressNotFound,
} from "@/core/grpc/errors";
import type { SecretMetadata } from "@/generated/modal_proto/api";
import { resourceInfoFromMetadata } from "@/utils/metadata";
import {
	allowExistingObjectCreationType,
	ephemeralObjectCreationType,
} from "@/utils/object_creation";
import {
	hasListCapacity,
	listPageSize,
	resolveListPagination,
} from "@/utils/pagination";
import { aliasedBoolean, environmentParam } from "@/utils/param_aliases";

/**
 * Optional parameters for {@link SecretService#fromName client.secrets.fromName()}
 * @property environment - Environment name to use
 * @property requiredKeys - Keys required in the Secret
 */
export type SecretFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	requiredKeys?: string[];
	required_keys?: string[];
};

/**
 * Optional parameters for {@link SecretService#fromObject client.secrets.fromObject()}
 * @property environment - Environment name to use
 */
export type SecretFromObjectParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * Optional parameters for {@link SecretService#fromDotenv client.secrets.fromDotenv()}
 * @property environment - Environment name to use
 */
export type SecretFromDotenvParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * Optional parameters for {@link SecretService#fromLocalEnviron client.secrets.fromLocalEnviron()}
 * @property environment - Environment name to use
 */
export type SecretFromLocalEnvironParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * Optional parameters for {@link SecretService#create client.secrets.create()}
 * @property environment - Environment name to use
 * @property allowExisting - Whether to treat an existing Secret as success
 */
export type SecretCreateParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowExisting?: boolean;
	allow_existing?: boolean;
};

/**
 * Optional parameters for {@link SecretService#list client.secrets.list()}
 * @property environment - Environment name to use
 * @property maxObjects - Maximum number of objects to fetch
 * @property createdBefore - Return only Secrets created before this Unix timestamp
 */
export type SecretListParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	maxObjects?: number;
	max_objects?: number;
	createdBefore?: number;
	created_before?: number;
};

/**
 * Optional parameters for {@link SecretService#update client.secrets.update()}
 * @property environment - Environment name to use
 */
export type SecretUpdateParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * Optional parameters for {@link SecretService#delete client.secrets.delete()}
 * @property environment - Environment name to use
 * @property allowMissing - Whether to suppress errors when the Secret does not exist
 */
export type SecretDeleteParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowMissing?: boolean;
	allow_missing?: boolean;
};

/**
 * Service for managing {@link Secret}
 *
 * Usually accessed only through the client:
 * ```typescript
 * const modal = new ModalClient();
 * const secret = await modal.secrets.fromName("my-secret");
 * ```
 */
export class SecretService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * Looks up a {@link Secret} by name
	 * @param name - Secret name
	 * @param params - Optional parameters
	 * @returns Secret instance
	 */
	async fromName(name: string, params?: SecretFromNameParams): Promise<Secret> {
		try {
			const resp = await this.#client.cpClient.secretGetOrCreate({
				deploymentName: name,
				environmentName: this.#client.environmentName(environmentParam(params)),
				requiredKeys: params?.requiredKeys ?? params?.required_keys ?? [],
			});
			this.#client.logger.debug(
				"Retrieved Secret",
				"secret_id",
				resp.secretId,
				"secret_name",
				name,
			);
			return new Secret(resp.secretId, name);
		} catch (err) {
			rethrowNotFound(err, { preconditionPatterns: ["Secret is missing key"] });
		}
	}

	async from_name(
		name: string,
		params?: SecretFromNameParams,
	): Promise<Secret> {
		return await this.fromName(name, params);
	}

	/**
	 * Creates a {@link Secret} from key/value pairs
	 * @param entries - Object containing string keys and values
	 * @param params - Optional parameters
	 * @returns Secret instance
	 */
	async fromObject(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		for (const value of Object.values(entries)) {
			if (value == null || typeof value !== "string") {
				throw new InvalidError(
					"entries must be an object mapping string keys to string values, but got:\n" +
						JSON.stringify(entries),
				);
			}
		}

		try {
			const resp = await this.#client.cpClient.secretGetOrCreate({
				objectCreationType: ephemeralObjectCreationType,
				envDict: entries,
				environmentName: this.#client.environmentName(environmentParam(params)),
			});
			this.#client.logger.debug(
				"Created ephemeral Secret",
				"secret_id",
				resp.secretId,
			);
			return new Secret(resp.secretId);
		} catch (err) {
			rethrowInvalid(err, { preconditionPatterns: [] });
		}
	}

	async from_dict(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await this.fromObject(entries, params);
	}

	/**
	 * Creates an ephemeral {@link Secret} from a .env file
	 * @param path - Path to the .env file
	 * @param params - Optional parameters
	 */
	async fromDotenv(
		path = ".env",
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		const contents = await readFile(path, "utf8");
		return await this.fromObject(parseDotenv(contents), params);
	}

	async from_dotenv(
		path?: string,
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		return await this.fromDotenv(path, params);
	}

	/**
	 * Creates an ephemeral {@link Secret} from local environment variables
	 * @param keys - Environment variable names to include; when omitted, includes all current environment variables
	 * @param params - Optional parameters
	 */
	async fromLocalEnviron(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		const entries: Record<string, string> = {};
		for (const key of keys ?? Object.keys(process.env)) {
			const value = process.env[key];
			if (value === undefined) {
				throw new InvalidError(`Environment variable ${key} is not set`);
			}
			entries[key] = value;
		}
		return await this.fromObject(entries, params);
	}

	async from_local_environ(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		return await this.fromLocalEnviron(keys, params);
	}

	/**
	 * Creates a named Secret
	 * @param name - Secret name
	 * @param entries - Key/value pairs to store
	 * @param params - Optional parameters
	 */
	async create(
		name: string,
		entries: Record<string, string>,
		params: SecretCreateParams = {},
	): Promise<void> {
		validateSecretEntries(entries);
		await this.#client.cpClient.secretGetOrCreate({
			deploymentName: name,
			envDict: entries,
			objectCreationType: allowExistingObjectCreationType(params),
			environmentName: this.#client.environmentName(environmentParam(params)),
		});
	}

	/**
	 * Lists named Secrets
	 * @param params - Optional parameters
	 */
	async list(params: SecretListParams = {}): Promise<Secret[]> {
		const pagination = resolveListPagination(params);
		const secrets: Secret[] = [];
		let createdBefore = pagination.createdBefore;
		while (hasListCapacity(pagination.maxObjects, secrets.length)) {
			const maxPageSize = listPageSize(pagination.maxObjects, secrets.length);
			const resp = await this.#client.cpClient.secretList({
				environmentName: this.#client.environmentName(environmentParam(params)),
				pagination: { maxObjects: maxPageSize, createdBefore },
			});

			if (!resp.items || resp.items.length === 0) break;
			for (const item of resp.items) {
				secrets.push(
					new Secret(
						item.secretId,
						item.metadata?.name || item.label || undefined,
						secretInfoFromMetadata(item.metadata, item.label),
					),
				);
			}
			if (resp.items.length < maxPageSize) break;
			createdBefore =
				resp.items[resp.items.length - 1]?.metadata?.creationInfo?.createdAt ??
				0;
		}

		return secrets;
	}

	/**
	 * Updates keys in a named Secret. Keys with null values are deleted
	 * @param name - Secret name
	 * @param updates - Updates to apply
	 * @param params - Optional parameters
	 */
	async update(
		name: string,
		updates: Record<string, string | null>,
		params: SecretUpdateParams = {},
	): Promise<void> {
		const environment = environmentParam(params);
		const secret = await this.fromName(name, {
			...(environment !== undefined && { environment }),
		});
		await this.#client.cpClient.secretUpdate({
			secretId: secret.secretId,
			updates: Object.entries(updates).map(([key, value]) => ({
				key,
				...(value !== null && { value }),
			})),
		});
	}

	/**
	 * Deletes a named {@link Secret}. Deletion is irreversible and affects any App currently using it
	 * @param name - Name of the Secret to delete
	 * @param params - Optional parameters
	 */
	async delete(name: string, params?: SecretDeleteParams): Promise<void> {
		try {
			const environment = environmentParam(params);
			const secret = await this.fromName(name, {
				...(environment !== undefined && { environment }),
			});
			await this.#client.cpClient.secretDelete({
				secretId: secret.secretId,
			});
			this.#client.logger.debug(
				"Deleted Secret",
				"secret_name",
				name,
				"secret_id",
				secret.secretId,
			);
		} catch (err) {
			suppressNotFound(
				err,
				aliasedBoolean(params, "allowMissing", "allow_missing"),
			);
		}
	}
}

/**
 * Secret that provides a dictionary of environment variables to an {@link Image}
 */
export class Secret {
	readonly secretId: string;
	readonly name?: string;
	readonly #info?: SecretInfo;

	/**
	 * @internal
	 */
	constructor(secretId: string, name?: string, info?: SecretInfo) {
		this.secretId = secretId;
		if (name !== undefined) this.name = name;
		if (info !== undefined) this.#info = info;
	}

	static get objects(): SecretService {
		return getDefaultClient().secrets;
	}

	static async create(
		name: string,
		entries: Record<string, string>,
		params: SecretCreateParams = {},
	): Promise<void> {
		await getDefaultClient().secrets.create(name, entries, params);
	}

	static async list(params: SecretListParams = {}): Promise<Secret[]> {
		return await getDefaultClient().secrets.list(params);
	}

	static async delete(
		name: string,
		params?: SecretDeleteParams,
	): Promise<void> {
		await getDefaultClient().secrets.delete(name, params);
	}

	static async from_name(
		name: string,
		params?: SecretFromNameParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromName(name, params);
	}

	static async fromName(
		name: string,
		params?: SecretFromNameParams,
	): Promise<Secret> {
		return await Secret.from_name(name, params);
	}

	static async from_dict(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromObject(entries, params);
	}

	static async fromDict(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await Secret.from_dict(entries, params);
	}

	static async from_object(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await Secret.from_dict(entries, params);
	}

	static async fromObject(
		entries: Record<string, string>,
		params?: SecretFromObjectParams,
	): Promise<Secret> {
		return await Secret.from_object(entries, params);
	}

	static async from_dotenv(
		path?: string,
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromDotenv(path, params);
	}

	static async fromDotenv(
		path?: string,
		params?: SecretFromDotenvParams,
	): Promise<Secret> {
		return await Secret.from_dotenv(path, params);
	}

	static async from_local_environ(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		return await getDefaultClient().secrets.fromLocalEnviron(keys, params);
	}

	static async fromLocalEnviron(
		keys?: string[],
		params?: SecretFromLocalEnvironParams,
	): Promise<Secret> {
		return await Secret.from_local_environ(keys, params);
	}

	/**
	 * Returns Secret metadata
	 */
	info(): SecretInfo {
		return this.#info ?? secretInfoFromMetadata(undefined, this.name);
	}

	async update(
		updates: Record<string, string | null>,
		params: SecretUpdateParams = {},
	): Promise<void> {
		if (!this.name) {
			throw new InvalidError("Cannot update a Secret handle without a name.");
		}
		await getDefaultClient().secrets.update(this.name, updates, params);
	}
}

/**
 * Merges an environment variable object into a Secret array. When env is specified, creates and adds an ephemeral Secret
 * @param client - Modal client
 * @param env - Environment variables to merge
 * @param secrets - Existing Secret array
 * @returns Merged Secret array
 */
export async function mergeEnvIntoSecrets(
	client: ModalClient,
	env?: Record<string, string>,
	secrets?: Secret[],
): Promise<Secret[]> {
	const result = [...(secrets || [])];
	if (env && Object.keys(env).length > 0) {
		result.push(await client.secrets.fromObject(env));
	}
	return result;
}

/**
 * Metadata for a Secret object
 */
export type SecretInfo = {
	name?: string;
	createdAt?: number;
	createdBy?: string;
};

function validateSecretEntries(entries: Record<string, string>) {
	for (const value of Object.values(entries)) {
		if (value == null || typeof value !== "string") {
			throw new InvalidError(
				"entries must be an object mapping string keys to string values, but got:\n" +
					JSON.stringify(entries),
			);
		}
	}
}

function parseDotenv(contents: string): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
		const eq = normalized.indexOf("=");
		if (eq < 0) continue;
		const key = normalized.slice(0, eq).trim();
		let value = normalized.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) entries[key] = value;
	}
	return entries;
}

function secretInfoFromMetadata(
	metadata?: SecretMetadata,
	fallbackName?: string,
): SecretInfo {
	return resourceInfoFromMetadata<SecretInfo>(metadata, fallbackName);
}
