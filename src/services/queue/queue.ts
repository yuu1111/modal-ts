import { setTimeout } from "node:timers/promises";
import { ClientError, Status } from "nice-grpc";
import type { ModalClient } from "@/core/client";
import { InvalidError, QueueEmptyError, QueueFullError } from "@/core/errors";
import { rethrowNotFound, suppressNotFound } from "@/core/grpc/errors";
import {
	ObjectCreationType,
	type QueueNextItemsRequest,
} from "@/generated/modal_proto/api";
import { EphemeralHeartbeatManager } from "@/utils/ephemeral";
import { loads as pickleDecode, dumps as pickleEncode } from "@/utils/pickle";
import { encodeIfString } from "@/utils/streams";
import { checkForRenamedParams } from "@/utils/validation";

/**
 * @description put 操作の初期バックオフ時間(ミリ秒)
 */
const queueInitialPutBackoffMs = 100;

/**
 * @description パーティションのデフォルト TTL(ミリ秒、24時間)
 */
const queueDefaultPartitionTtlMs = 24 * 3600 * 1000;

/**
 * @description {@link QueueService#fromName client.queues.fromName()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property createIfMissing - 存在しない場合に自動作成するかどうか
 */
export type QueueFromNameParams = {
	environment?: string;
	createIfMissing?: boolean;
};

/**
 * @description {@link QueueService#delete client.queues.delete()} のオプションパラメータ
 * @property environment - 使用する環境名
 * @property allowMissing - 存在しない場合にエラーを抑制するかどうか
 */
export type QueueDeleteParams = {
	environment?: string;
	allowMissing?: boolean;
};

/**
 * @description {@link QueueService#ephemeral client.queues.ephemeral()} のオプションパラメータ
 * @property environment - 使用する環境名
 */
export type QueueEphemeralParams = {
	environment?: string;
};

/**
 * @description {@link Queue} を管理するサービス
 *
 * 通常はクライアント経由でのみアクセスする:
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
	 * @description 名前のない一時的な {@link Queue} を作成する。削除するには {@link Queue#closeEphemeral Queue.closeEphemeral()} を呼び出す必要がある
	 * @param params - オプションパラメータ
	 * @returns 一時的な Queue インスタンス
	 */
	async ephemeral(params: QueueEphemeralParams = {}): Promise<Queue> {
		const resp = await this.#client.cpClient.queueGetOrCreate({
			objectCreationType: ObjectCreationType.OBJECT_CREATION_TYPE_EPHEMERAL,
			environmentName: this.#client.environmentName(params.environment),
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
	 * @description 名前で {@link Queue} を参照する
	 * @param name - Queue の名前
	 * @param params - オプションパラメータ
	 * @returns Queue インスタンス
	 */
	async fromName(
		name: string,
		params: QueueFromNameParams = {},
	): Promise<Queue> {
		try {
			const resp = await this.#client.cpClient.queueGetOrCreate({
				deploymentName: name,
				...(params.createIfMissing && {
					objectCreationType:
						ObjectCreationType.OBJECT_CREATION_TYPE_CREATE_IF_MISSING,
				}),
				environmentName: this.#client.environmentName(params.environment),
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

	/**
	 * @description 名前付き {@link Queue} を削除する。削除は不可逆で、現在使用中の App にも影響する
	 * @param name - 削除する Queue の名前
	 * @param params - オプションパラメータ
	 */
	async delete(name: string, params: QueueDeleteParams = {}): Promise<void> {
		try {
			const queue = await this.fromName(name, {
				...(params.environment !== undefined && {
					environment: params.environment,
				}),
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
			suppressNotFound(err, params.allowMissing);
		}
	}
}

/**
 * @description {@link Queue#clear Queue.clear()} のオプションパラメータ
 * @property partition - クリアするパーティション。未設定の場合はデフォルトパーティションを使用
 * @property all - すべてのパーティションをクリアするかどうか
 */
export type QueueClearParams = {
	/**
	 * @description クリアするパーティション。未設定ならデフォルトパーティションを使用
	 */
	partition?: string;

	/**
	 * @description すべてのパーティションをクリアする
	 */
	all?: boolean;
};

/**
 * @description {@link Queue#get Queue.get()} のオプションパラメータ
 * @property timeoutMs - Queue が空の場合の待機時間(ミリ秒)。デフォルトは無期限
 * @property partition - 値を取得するパーティション。未設定の場合はデフォルトパーティションを使用
 */
export type QueueGetParams = {
	/**
	 * @description Queue が空の場合の待機時間(ミリ秒)。デフォルトは無期限
	 */
	timeoutMs?: number;

	/**
	 * @description 値を取得するパーティション。未設定ならデフォルトパーティションを使用
	 */
	partition?: string;
};

/**
 * @description {@link Queue#getMany Queue.getMany()} のオプションパラメータ
 */
export type QueueGetManyParams = QueueGetParams;

/**
 * @description {@link Queue#put Queue.put()} のオプションパラメータ
 * @property timeoutMs - Queue が満杯の場合の待機時間(ミリ秒)。デフォルトは無期限
 * @property partition - アイテムを追加するパーティション。未設定の場合はデフォルトパーティションを使用
 * @property partitionTtlMs - パーティションの TTL(ミリ秒) @defaultValue 86400000
 */
export type QueuePutParams = {
	/**
	 * @description Queue が満杯の場合の待機時間(ミリ秒)。デフォルトは無期限
	 */
	timeoutMs?: number;

	/**
	 * @description アイテムを追加するパーティション。未設定ならデフォルトパーティションを使用
	 */
	partition?: string;

	/**
	 * @description パーティションの TTL(ミリ秒) @defaultValue 86400000
	 */
	partitionTtlMs?: number;
};

/**
 * @description {@link Queue#putMany Queue.putMany()} のオプションパラメータ
 */
export type QueuePutManyParams = QueuePutParams;

/**
 * @description {@link Queue#len Queue.len()} のオプションパラメータ
 * @property partition - 長さを計算するパーティション。未設定の場合はデフォルトパーティションを使用
 * @property total - すべてのパーティションの合計長を返すかどうか
 */
export type QueueLenParams = {
	/**
	 * @description 長さを計算するパーティション。未設定ならデフォルトパーティションを使用
	 */
	partition?: string;

	/**
	 * @description すべてのパーティションの合計長を返す
	 */
	total?: boolean;
};

/**
 * @description {@link Queue#iterate Queue.iterate()} のオプションパラメータ
 * @property itemPollTimeoutMs - 次のアイテムまでの待機時間(ミリ秒)。超過するとイテレーション終了 @defaultValue 0
 * @property partition - イテレートするパーティション。未設定の場合はデフォルトパーティションを使用
 */
export type QueueIterateParams = {
	/**
	 * @description 次のアイテムまでの待機時間(ミリ秒)。超過するとイテレーション終了 @defaultValue 0
	 */
	itemPollTimeoutMs?: number;

	/**
	 * @description イテレートするパーティション。未設定ならデフォルトパーティションを使用
	 */
	partition?: string;
};

/**
 * @description Modal {@link App} 内のデータフロー用分散 FIFO キュー
 */
export class Queue {
	readonly #client: ModalClient;
	readonly queueId: string;
	readonly name?: string;
	readonly #ephemeralHbManager?: EphemeralHeartbeatManager;

	/**
	 * @internal
	 */
	constructor(
		client: ModalClient,
		queueId: string,
		name?: string,
		ephemeralHbManager?: EphemeralHeartbeatManager,
	) {
		this.#client = client;
		this.queueId = queueId;
		if (name !== undefined) this.name = name;
		if (ephemeralHbManager !== undefined)
			this.#ephemeralHbManager = ephemeralHbManager;
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
	 * @description 一時的な Queue を削除する。一時的な Queue でのみ使用可能
	 */
	closeEphemeral(): void {
		if (this.#ephemeralHbManager) {
			this.#ephemeralHbManager.stop();
		} else {
			throw new InvalidError("Queue is not ephemeral.");
		}
	}

	/**
	 * @description Queue パーティションからすべてのオブジェクトを削除する
	 * @param params - オプションパラメータ
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

	/**
	 * @description Queue から次のオブジェクトを取り出して返す。デフォルトではアイテムが存在するまで待機する
	 * @param params - オプションパラメータ
	 * @returns Queue から取り出したオブジェクト
	 * @throws timeoutMs 設定時、タイムアウト内にアイテムがなければ QueueEmptyError
	 */
	async get(params: QueueGetParams = {}): Promise<unknown | null> {
		checkForRenamedParams(params, { timeout: "timeoutMs" });

		const values = await this.#get(1, params.partition, params.timeoutMs);
		return values[0];
	}

	/**
	 * @description Queue から最大 n 個のオブジェクトを取り出して返す。デフォルトではアイテムが存在するまで待機する
	 * @param n - 取得する最大アイテム数
	 * @param params - オプションパラメータ
	 * @returns 取り出したオブジェクトの配列
	 * @throws timeoutMs 設定時、タイムアウト内にアイテムがなければ QueueEmptyError
	 */
	async getMany(
		n: number,
		params: QueueGetManyParams = {},
	): Promise<unknown[]> {
		checkForRenamedParams(params, { timeout: "timeoutMs" });

		return await this.#get(n, params.partition, params.timeoutMs);
	}

	async #put(
		values: unknown[],
		timeoutMs?: number,
		partition?: string,
		partitionTtlMs?: number,
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
					// Queue が満杯。デッドラインまで指数バックオフでリトライ
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
	 * @description Queue の末尾にアイテムを追加する。満杯の場合は指数バックオフでリトライする
	 * @param v - 追加するアイテム
	 * @param params - オプションパラメータ
	 * @throws タイムアウト後も満杯の場合 {@link QueueFullError}
	 */
	async put(v: unknown, params: QueuePutParams = {}): Promise<void> {
		checkForRenamedParams(params, {
			timeout: "timeoutMs",
			partitionTtl: "partitionTtlMs",
		});

		await this.#put(
			[v],
			params.timeoutMs,
			params.partition,
			params.partitionTtlMs,
		);
	}

	/**
	 * @description Queue の末尾に複数のアイテムを追加する。満杯の場合は指数バックオフでリトライする
	 * @param values - 追加するアイテムの配列
	 * @param params - オプションパラメータ
	 * @throws タイムアウト後も満杯の場合 {@link QueueFullError}
	 */
	async putMany(
		values: unknown[],
		params: QueuePutManyParams = {},
	): Promise<void> {
		checkForRenamedParams(params, {
			timeout: "timeoutMs",
			partitionTtl: "partitionTtlMs",
		});

		await this.#put(
			values,
			params.timeoutMs,
			params.partition,
			params.partitionTtlMs,
		);
	}

	/**
	 * @description Queue 内のオブジェクト数を返す
	 * @param params - オプションパラメータ
	 * @returns オブジェクト数
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
	 * @description Queue 内のアイテムを変更せずにイテレートする
	 * @param params - オプションパラメータ
	 */
	async *iterate(
		params: QueueIterateParams = {},
	): AsyncGenerator<unknown, void, unknown> {
		checkForRenamedParams(params, { itemPollTimeout: "itemPollTimeoutMs" });

		const { partition, itemPollTimeoutMs = 0 } = params;

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
