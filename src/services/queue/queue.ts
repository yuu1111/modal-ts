import { setTimeout } from "node:timers/promises";
import { ClientError, Status } from "nice-grpc";
import { getDefaultClient, type ModalClient } from "@/core/client";
import { InvalidError, QueueEmptyError, QueueFullError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import {
	ObjectCreationType,
	type QueueMetadata,
	type QueueNextItemsRequest,
} from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";
import {
	aliasedBoolean,
	aliasedNumber,
	environmentParam,
} from "@/utils/param_aliases";
import { loads as pickleDecode, dumps as pickleEncode } from "@/utils/pickle";
import { encodeIfString } from "@/utils/streams";

/**
 * @description Initial backoff time for put operations in milliseconds
 */
const queueInitialPutBackoffMs = 100;

/**
 * @description Default partition TTL in milliseconds, 24 hours
 */
const queueDefaultPartitionTtlMs = 24 * 3600 * 1000;

/**
 * @description Optional parameters for {@link QueueService#fromName client.queues.fromName()}
 * @property environment - Environment name to use
 * @property createIfMissing - Whether to create automatically when missing
 */
export type QueueFromNameParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	createIfMissing?: boolean;
	create_if_missing?: boolean;
};

/**
 * @description Optional parameters for {@link QueueService#create client.queues.create()}
 * @property environment - Environment name to use
 * @property allowExisting - Whether to treat an existing Queue as success
 */
export type QueueCreateParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowExisting?: boolean;
	allow_existing?: boolean;
};

/**
 * @description Optional parameters for {@link QueueService#list client.queues.list()}
 * @property environment - Environment name to use
 * @property maxObjects - Maximum number of objects to fetch
 * @property createdBefore - Return only Queues created before this Unix timestamp
 */
export type QueueListParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	maxObjects?: number;
	max_objects?: number;
	createdBefore?: number;
	created_before?: number;
};

/**
 * @description Optional parameters for {@link QueueService#delete client.queues.delete()}
 * @property environment - Environment name to use
 * @property allowMissing - Whether to suppress errors when the Queue does not exist
 */
export type QueueDeleteParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
	allowMissing?: boolean;
	allow_missing?: boolean;
};

/**
 * @description Optional parameters for {@link QueueService#ephemeral client.queues.ephemeral()}
 * @property environment - Environment name to use
 */
export type QueueEphemeralParams = {
	environment?: string;
	environmentName?: string;
	environment_name?: string;
};

/**
 * @description Service for managing {@link Queue}
 *
 * Usually accessed only through the client:
 * ```typescript
 * const modal = new ModalClient();
 * const queue = await modal.queues.fromName("my-queue");
 * ```
 */
export class QueueService {
	readonly #client: ModalClient;
	constructor(client: ModalClient) {
		this.#client = client;
	}

	/**
	 * @description Creates an unnamed ephemeral {@link Queue}. Call {@link Queue#closeEphemeral Queue.closeEphemeral()} to delete it
	 * @param params - Optional parameters
	 * @returns Ephemeral Queue instance
	 */
	async ephemeral(params: QueueEphemeralParams = {}): Promise<Queue> {
		const resp = await this.#client.cpClient.queueGetOrCreate({
			objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
			environmentName: this.#client.environmentName(environmentParam(params)),
		});

		this.#client.logger.debug(
			"Created ephemeral Queue",
			"queue_id",
			resp.queueId,
		);

		const ephemeralHbManager = new EphemeralHeartbeatManager(() =>
			this.#client.cpClient.queueHeartbeat({ queueId: resp.queueId }),
		);

		return new Queue(this.#client, resp.queueId, undefined, ephemeralHbManager);
	}

	/**
	 * @description Creates a named Queue
	 * @param name - Queue name
	 * @param params - Optional parameters
	 */
	async create(name: string, params: QueueCreateParams = {}): Promise<void> {
		await this.#client.cpClient.queueGetOrCreate({
			deploymentName: name,
			objectCreationType: aliasedBoolean(
				params,
				"allowExisting",
				"allow_existing",
			)
				? ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING
				: ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_FAIL_IF_EXISTS,
			environmentName: this.#client.environmentName(environmentParam(params)),
		});
	}

	/**
	 * @description Looks up a {@link Queue} by ID
	 * @param queueId - Queue ID
	 */
	async fromId(queueId: string): Promise<Queue> {
		try {
			const resp = await this.#client.cpClient.queueGetById({ queueId });
			return new Queue(
				this.#client,
				queueId,
				resp.metadata?.name || undefined,
				undefined,
				queueInfoFromMetadata(resp.metadata),
			);
		} catch (err) {
			rethrowNotFound(err, `Queue with id: '${queueId}' not found`);
		}
	}

	async from_id(queueId: string): Promise<Queue> {
		return await this.fromId(queueId);
	}

	/**
	 * @description Looks up a {@link Queue} by name
	 * @param name - Queue name
	 * @param params - Optional parameters
	 * @returns Queue instance
	 */
	async fromName(
		name: string,
		params: QueueFromNameParams = {},
	): Promise<Queue> {
		try {
			const resp = await this.#client.cpClient.queueGetOrCreate({
				deploymentName: name,
				...(aliasedBoolean(params, "createIfMissing", "create_if_missing") && {
					objectCreationType:
						ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING,
				}),
				environmentName: this.#client.environmentName(environmentParam(params)),
			});
			this.#client.logger.debug(
				"Retrieved Queue",
				"queue_id",
				resp.queueId,
				"queue_name",
				name,
			);
			return new Queue(this.#client, resp.queueId, name);
		} catch (err) {
			rethrowNotFound(err);
		}
	}

	async from_name(
		name: string,
		params: QueueFromNameParams = {},
	): Promise<Queue> {
		return await this.fromName(name, params);
	}

	/**
	 * @description Lists named Queues
	 * @param params - Optional parameters
	 */
	async list(params: QueueListParams = {}): Promise<Queue[]> {
		const maxObjects = aliasedNumber(params, "maxObjects", "max_objects");
		if (maxObjects !== undefined && maxObjects < 0) {
			throw new InvalidError("maxObjects cannot be negative");
		}

		const queues: Queue[] = [];
		let createdBefore =
			aliasedNumber(params, "createdBefore", "created_before") ?? 0;
		while (maxObjects === undefined || queues.length < maxObjects) {
			const maxPageSize =
				maxObjects === undefined
					? 100
					: Math.min(100, maxObjects - queues.length);
			const resp = await this.#client.cpClient.queueList({
				environmentName: this.#client.environmentName(environmentParam(params)),
				pagination: { maxObjects: maxPageSize, createdBefore },
			});

			if (!resp.queues || resp.queues.length === 0) break;
			for (const item of resp.queues) {
				queues.push(
					new Queue(
						this.#client,
						item.queueId,
						item.metadata?.name || item.name || undefined,
						undefined,
						queueInfoFromMetadata(item.metadata, item.name, item.createdAt),
					),
				);
			}
			if (resp.queues.length < maxPageSize) break;
			createdBefore =
				resp.queues[resp.queues.length - 1]?.metadata?.creationInfo
					?.createdAt ??
				resp.queues[resp.queues.length - 1]?.createdAt ??
				0;
		}

		return queues;
	}

	/**
	 * @description Deletes a named {@link Queue}. Deletion is irreversible and affects any App currently using it
	 * @param name - Name of the Queue to delete
	 * @param params - Optional parameters
	 */
	async delete(name: string, params: QueueDeleteParams = {}): Promise<void> {
		try {
			const environment = environmentParam(params);
			const queue = await this.fromName(name, {
				...(environment !== undefined && { environment }),
				createIfMissing: false,
			});
			await this.#client.cpClient.queueDelete({ queueId: queue.queueId });
			this.#client.logger.debug(
				"Deleted Queue",
				"queue_name",
				name,
				"queue_id",
				queue.queueId,
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
 * @description Optional parameters for {@link Queue#clear Queue.clear()}
 * @property partition - Partition to clear; uses the default partition when omitted
 * @property all - Whether to clear all partitions
 */
export type QueueClearParams = {
	/**
	 * @description Partition to clear; uses the default partition when omitted
	 */
	partition?: string;

	/**
	 * @description Clears all partitions
	 */
	all?: boolean;
};

/**
 * @description Optional parameters for {@link Queue#get Queue.get()}
 * @property timeoutMs - Wait time in milliseconds when the Queue is empty; defaults to unlimited
 * @property partition - Partition to get values from; uses the default partition when omitted
 */
export type QueueGetParams = {
	/**
	 * @description When false, returns null immediately if empty
	 */
	block?: boolean;

	/**
	 * @description Wait time in milliseconds when the Queue is empty; defaults to unlimited
	 */
	timeoutMs?: number;
	timeout?: number;

	/**
	 * @description Partition to get values from; uses the default partition when omitted
	 */
	partition?: string;
};

/**
 * @description Optional parameters for {@link Queue#getMany Queue.getMany()}
 */
export type QueueGetManyParams = QueueGetParams;

/**
 * @description Optional parameters for {@link Queue#put Queue.put()}
 * @property timeoutMs - Wait time in milliseconds when the Queue is full; defaults to unlimited
 * @property partition - Partition to add the item to; uses the default partition when omitted
 * @property partitionTtlMs - Partition TTL in milliseconds @defaultValue 86400000
 */
export type QueuePutParams = {
	/**
	 * @description When false, throws QueueFullError immediately if full
	 */
	block?: boolean;

	/**
	 * @description Wait time in milliseconds when the Queue is full; defaults to unlimited
	 */
	timeoutMs?: number;
	timeout?: number;

	/**
	 * @description Partition to add the item to; uses the default partition when omitted
	 */
	partition?: string;

	/**
	 * @description Partition TTL in milliseconds @defaultValue 86400000
	 */
	partitionTtlMs?: number;
	partitionTtl?: number;
	partition_ttl?: number;
};

/**
 * @description Optional parameters for {@link Queue#putMany Queue.putMany()}
 */
export type QueuePutManyParams = QueuePutParams;

/**
 * @description Optional parameters for {@link Queue#len Queue.len()}
 * @property partition - Partition whose length is calculated; uses the default partition when omitted
 * @property total - Whether to return the total length across all partitions
 */
export type QueueLenParams = {
	/**
	 * @description Partition whose length is calculated; uses the default partition when omitted
	 */
	partition?: string;

	/**
	 * @description Returns the total length across all partitions
	 */
	total?: boolean;
};

/**
 * @description Optional parameters for {@link Queue#iterate Queue.iterate()}
 * @property itemPollTimeoutMs - Wait time in milliseconds for the next item; iteration ends when exceeded @defaultValue 0
 * @property partition - Partition to iterate; uses the default partition when omitted
 */
export type QueueIterateParams = {
	/**
	 * @description Wait time in milliseconds for the next item; iteration ends when exceeded @defaultValue 0
	 */
	itemPollTimeoutMs?: number;
	itemPollTimeout?: number;
	item_poll_timeout?: number;

	/**
	 * @description Partition to iterate; uses the default partition when omitted
	 */
	partition?: string;
};

/**
 * @description Metadata for a Queue object
 */
export type QueueInfo = {
	name?: string;
	createdAt?: number;
	createdBy?: string;
};

/**
 * @description Distributed FIFO queue for data flow inside a Modal {@link App}
 */
export class Queue {
	readonly #client: ModalClient;
	readonly queueId: string;
	readonly name?: string;
	readonly #info?: QueueInfo;
	readonly #ephemeralHbManager?: EphemeralHeartbeatManager;

	/**
	 * @internal
	 */
	constructor(
		client: ModalClient,
		queueId: string,
		name?: string,
		ephemeralHbManager?: EphemeralHeartbeatManager,
		info?: QueueInfo,
	) {
		this.#client = client;
		this.queueId = queueId;
		if (name !== undefined) this.name = name;
		if (info !== undefined) this.#info = info;
		if (ephemeralHbManager !== undefined)
			this.#ephemeralHbManager = ephemeralHbManager;
	}

	static get objects(): QueueService {
		return getDefaultClient().queues;
	}

	static async create(
		name: string,
		params: QueueCreateParams = {},
	): Promise<void> {
		await getDefaultClient().queues.create(name, params);
	}

	static async list(params: QueueListParams = {}): Promise<Queue[]> {
		return await getDefaultClient().queues.list(params);
	}

	static async delete(
		name: string,
		params: QueueDeleteParams = {},
	): Promise<void> {
		await getDefaultClient().queues.delete(name, params);
	}

	static validate_partition_key(partition: string | undefined): Uint8Array {
		return Queue.#validatePartitionKey(partition);
	}

	static validatePartitionKey(partition: string | undefined): Uint8Array {
		return Queue.validate_partition_key(partition);
	}

	static async ephemeral(params: QueueEphemeralParams = {}): Promise<Queue> {
		return await getDefaultClient().queues.ephemeral(params);
	}

	static async from_name(
		name: string,
		params: QueueFromNameParams = {},
	): Promise<Queue> {
		return await getDefaultClient().queues.fromName(name, params);
	}

	static async fromName(
		name: string,
		params: QueueFromNameParams = {},
	): Promise<Queue> {
		return await Queue.from_name(name, params);
	}

	static async from_id(queueId: string): Promise<Queue> {
		return await getDefaultClient().queues.fromId(queueId);
	}

	static async fromId(queueId: string): Promise<Queue> {
		return await Queue.from_id(queueId);
	}

	static #validatePartitionKey(partition: string | undefined): Uint8Array {
		if (partition) {
			const partitionKey = encodeIfString(partition);
			if (partitionKey.length === 0 || partitionKey.length > 64) {
				throw new InvalidError(
					"Queue partition key must be between 1 and 64 bytes.",
				);
			}
			return partitionKey;
		}
		return new Uint8Array();
	}

	/**
	 * @description Deletes an ephemeral Queue. Only available for ephemeral Queues
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("Queue is not ephemeral.");
		}
	}

	/**
	 * @description Returns Queue metadata
	 */
	info(): QueueInfo {
		return this.#info ?? queueInfoFromMetadata(undefined, this.name);
	}

	/**
	 * @description Removes all objects from a Queue partition
	 * @param params - Optional parameters
	 */
	async clear(params: QueueClearParams = {}): Promise<void> {
		if (params.partition && params.all) {
			throw new InvalidError(
				"Partition must be null when requesting to clear all.",
			);
		}
		await this.#client.cpClient.queueClear({
			queueId: this.queueId,
			partitionKey: Queue.#validatePartitionKey(params.partition),
			...(params.all !== undefined && { allPartitions: params.all }),
		});
	}

	async #get(
		n: number,
		partition?: string,
		timeoutMs?: number,
	): Promise<unknown[]> {
		const partitionKey = Queue.#validatePartitionKey(partition);

		const startTime = Date.now();
		let pollTimeoutMs = 50_000;
		if (timeoutMs !== undefined) {
			pollTimeoutMs = Math.min(pollTimeoutMs, timeoutMs);
		}

		while (true) {
			const response = await this.#client.cpClient.queueGet({
				queueId: this.queueId,
				partitionKey,
				timeout: pollTimeoutMs / 1000,
				nValues: n,
			});
			if (response.values && response.values.length > 0) {
				return response.values.map((value) => pickleDecode(value));
			}
			if (timeoutMs !== undefined) {
				const remainingMs = timeoutMs - (Date.now() - startTime);
				if (remainingMs <= 0) {
					const message = `Queue ${this.queueId} did not return values within ${timeoutMs}ms.`;
					throw new QueueEmptyError(message);
				}
				pollTimeoutMs = Math.min(pollTimeoutMs, remainingMs);
			}
		}
	}

	async #getNonblocking(n: number, partition?: string): Promise<unknown[]> {
		const response = await this.#client.cpClient.queueGet({
			queueId: this.queueId,
			partitionKey: Queue.#validatePartitionKey(partition),
			timeout: 0,
			nValues: n,
		});
		return (response.values ?? []).map((value) => pickleDecode(value));
	}

	/**
	 * @description Gets and returns the next object from the Queue. By default, waits until an item exists
	 * @param params - Optional parameters
	 * @returns Object taken from the Queue
	 * @throws QueueEmptyError when timeoutMs is set and no item is available before the timeout
	 */
	async get(params: QueueGetParams = {}): Promise<unknown | null> {
		const timeoutSeconds = aliasedNumber(params, "timeout", "timeout_s");
		const timeoutMs =
			params.timeoutMs ??
			(timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined);

		const values =
			params.block === false
				? await this.#getNonblocking(1, params.partition)
				: await this.#get(1, params.partition, timeoutMs);
		return values.length > 0 ? values[0] : null;
	}

	/**
	 * @description Gets and returns up to n objects from the Queue. By default, waits until items exist
	 * @param n - Maximum number of items to get
	 * @param params - Optional parameters
	 * @returns Objects taken from the Queue
	 * @throws QueueEmptyError when timeoutMs is set and no item is available before the timeout
	 */
	async getMany(
		n: number,
		params: QueueGetManyParams = {},
	): Promise<unknown[]> {
		const timeoutSeconds = aliasedNumber(params, "timeout", "timeout_s");
		const timeoutMs =
			params.timeoutMs ??
			(timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined);

		return params.block === false
			? await this.#getNonblocking(n, params.partition)
			: await this.#get(n, params.partition, timeoutMs);
	}

	async get_many(
		n: number,
		params: QueueGetManyParams = {},
	): Promise<unknown[]> {
		return await this.getMany(n, params);
	}

	async #put(
		values: unknown[],
		timeoutMs?: number,
		partition?: string,
		partitionTtlMs?: number,
		block = true,
	): Promise<void> {
		const valuesEncoded = values.map((v) => pickleEncode(v));
		const partitionKey = Queue.#validatePartitionKey(partition);

		let delay = queueInitialPutBackoffMs;
		const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
		while (true) {
			try {
				await this.#client.cpClient.queuePut({
					queueId: this.queueId,
					values: valuesEncoded,
					partitionKey,
					partitionTtlSeconds:
						(partitionTtlMs || queueDefaultPartitionTtlMs) / 1000,
				});
				break;
			} catch (e) {
				if (e instanceof ClientError && e.code === Status.RESOURCE_EXHAUSTED) {
					if (!block)
						throw new QueueFullError(`Put failed on ${this.queueId}.`);
					// The Queue is full. Retry with exponential backoff until the deadline.
					delay = Math.min(delay * 2, 30_000);
					if (deadline !== undefined) {
						const remaining = deadline - Date.now();
						if (remaining <= 0)
							throw new QueueFullError(`Put failed on ${this.queueId}.`);
						delay = Math.min(delay, remaining);
					}
					await setTimeout(delay);
				} else {
					throw e;
				}
			}
		}
	}

	/**
	 * @description Adds an item to the end of the Queue, retrying with exponential backoff when full
	 * @param v - Item to add
	 * @param params - Optional parameters
	 * @throws {@link QueueFullError} if the Queue is still full after the timeout
	 */
	async put(v: unknown, params: QueuePutParams = {}): Promise<void> {
		const timeoutSeconds = aliasedNumber(params, "timeout", "timeout_s");
		const partitionTtlSeconds = aliasedNumber(
			params,
			"partitionTtl",
			"partition_ttl",
		);
		const timeoutMs =
			params.timeoutMs ??
			(timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined);
		const partitionTtlMs =
			params.partitionTtlMs ??
			(partitionTtlSeconds !== undefined
				? partitionTtlSeconds * 1000
				: undefined);

		await this.#put(
			[v],
			timeoutMs,
			params.partition,
			partitionTtlMs,
			params.block ?? true,
		);
	}

	/**
	 * @description Adds multiple items to the end of the Queue, retrying with exponential backoff when full
	 * @param values - Items to add
	 * @param params - Optional parameters
	 * @throws {@link QueueFullError} if the Queue is still full after the timeout
	 */
	async putMany(
		values: unknown[],
		params: QueuePutManyParams = {},
	): Promise<void> {
		const timeoutSeconds = aliasedNumber(params, "timeout", "timeout_s");
		const partitionTtlSeconds = aliasedNumber(
			params,
			"partitionTtl",
			"partition_ttl",
		);
		const timeoutMs =
			params.timeoutMs ??
			(timeoutSeconds !== undefined ? timeoutSeconds * 1000 : undefined);
		const partitionTtlMs =
			params.partitionTtlMs ??
			(partitionTtlSeconds !== undefined
				? partitionTtlSeconds * 1000
				: undefined);

		await this.#put(
			values,
			timeoutMs,
			params.partition,
			partitionTtlMs,
			params.block ?? true,
		);
	}

	async put_many(
		values: unknown[],
		params: QueuePutManyParams = {},
	): Promise<void> {
		await this.putMany(values, params);
	}

	/**
	 * @description Returns the number of objects in the Queue
	 * @param params - Optional parameters
	 * @returns Object count
	 */
	async len(params: QueueLenParams = {}): Promise<number> {
		if (params.partition && params.total) {
			throw new InvalidError(
				"Partition must be null when requesting total length.",
			);
		}
		const resp = await this.#client.cpClient.queueLen({
			queueId: this.queueId,
			partitionKey: Queue.#validatePartitionKey(params.partition),
			...(params.total !== undefined && { total: params.total }),
		});
		return resp.len;
	}

	/**
	 * @description Iterates items in the Queue without modifying them
	 * @param params - Optional parameters
	 */
	async *iterate(
		params: QueueIterateParams = {},
	): AsyncGenerator<unknown, void, unknown> {
		const { partition } = params;
		const itemPollTimeoutSeconds = aliasedNumber(
			params,
			"itemPollTimeout",
			"item_poll_timeout",
		);
		const itemPollTimeoutMs =
			params.itemPollTimeoutMs ??
			(itemPollTimeoutSeconds !== undefined
				? itemPollTimeoutSeconds * 1000
				: undefined) ??
			0;

		let lastEntryId: string | undefined;
		const validatedPartitionKey = Queue.#validatePartitionKey(partition);
		let fetchDeadline = Date.now() + itemPollTimeoutMs;

		const maxPollDurationMs = 30_000;
		while (true) {
			const pollDurationMs = Math.max(
				0.0,
				Math.min(maxPollDurationMs, fetchDeadline - Date.now()),
			);
			const request: QueueNextItemsRequest = {
				queueId: this.queueId,
				partitionKey: validatedPartitionKey,
				itemPollTimeout: pollDurationMs / 1000,
				lastEntryId: lastEntryId ?? "",
			};

			const response = await this.#client.cpClient.queueNextItems(request);
			if (response.items && response.items.length > 0) {
				for (const item of response.items) {
					yield pickleDecode(item.value);
					lastEntryId = item.entryId;
				}
				fetchDeadline = Date.now() + itemPollTimeoutMs;
			} else if (Date.now() > fetchDeadline) {
				break;
			}
		}
	}
}

function queueInfoFromMetadata(
	metadata?: QueueMetadata,
	fallbackName?: string,
	fallbackCreatedAt?: number,
): QueueInfo {
	const info: QueueInfo = {};
	const name = metadata?.name || fallbackName;
	const createdAt = metadata?.creationInfo?.createdAt || fallbackCreatedAt;
	const createdBy = metadata?.creationInfo?.createdBy;
	if (name) info.name = name;
	if (createdAt) info.createdAt = createdAt;
	if (createdBy) info.createdBy = createdBy;
	return info;
}
