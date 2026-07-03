import type { ModalClient, ModalGrpcClient } from "@/core/client";
import { SandboxFilesystemError } from "@/core/errors";
import { isRetryableGrpc } from "@/core/grpc/utils";
import type {
	ContainerFilesystemExecRequest,
	ContainerFilesystemExecResponse,
	DeepPartial,
} from "@/generated/modal_proto/api";

/**
 * @description File open modes supported by the filesystem API
 */
export type SandboxFileMode = "r" | "w" | "a" | "r+" | "w+" | "a+";

/**
 * @description Represents an open file in a {@link Sandbox} filesystem
 *
 * Provides read and write operations similar to Node.js `fsPromises.FileHandle`.
 */
export class SandboxFile {
	readonly #client: ModalClient;
	readonly #fileDescriptor: string;
	readonly #taskId: string;

	/** @internal */
	constructor(client: ModalClient, fileDescriptor: string, taskId: string) {
		this.#client = client;
		this.#fileDescriptor = fileDescriptor;
		this.#taskId = taskId;
	}

	/**
	 * @description Reads data from the file
	 * @returns Read data as bytes
	 */
	async read(): Promise<Uint8Array> {
		const resp = await runFilesystemExec(this.#client.cpClient, {
			fileReadRequest: {
				fileDescriptor: this.#fileDescriptor,
			},
			taskId: this.#taskId,
		});
		const chunks = resp.chunks;
		if (chunks.length === 0) return new Uint8Array(0);

		const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}

	/**
	 * @description Writes data to the file
	 * @param data - Bytes to write
	 */
	async write(data: Uint8Array): Promise<void> {
		await runFilesystemExec(this.#client.cpClient, {
			fileWriteRequest: {
				fileDescriptor: this.#fileDescriptor,
				data,
			},
			taskId: this.#taskId,
		});
	}

	/**
	 * @description Flushes buffered data to the file
	 */
	async flush(): Promise<void> {
		await runFilesystemExec(this.#client.cpClient, {
			fileFlushRequest: {
				fileDescriptor: this.#fileDescriptor,
			},
			taskId: this.#taskId,
		});
	}

	/**
	 * @description Closes the file handle
	 */
	async close(): Promise<void> {
		await runFilesystemExec(this.#client.cpClient, {
			fileCloseRequest: {
				fileDescriptor: this.#fileDescriptor,
			},
			taskId: this.#taskId,
		});
	}
}

/**
 * @description Executes a Sandbox filesystem operation and collects the response
 * @param cpClient - gRPC client
 * @param request - Execution request
 * @returns Output chunks and response
 */
export async function runFilesystemExec(
	cpClient: ModalGrpcClient,
	request: DeepPartial<ContainerFilesystemExecRequest>,
): Promise<{
	chunks: Uint8Array[];
	response: ContainerFilesystemExecResponse;
}> {
	const response = await cpClient.containerFilesystemExec(request);

	const chunks: Uint8Array[] = [];
	let retries = 10;
	let completed = false;
	while (!completed) {
		try {
			const outputIterator = cpClient.containerFilesystemExecGetOutput({
				execId: response.execId,
				timeout: 55,
			});
			for await (const batch of outputIterator) {
				chunks.push(...batch.output);
				if (batch.eof) {
					completed = true;
					break;
				}
				if (batch.error !== undefined) {
					if (retries > 0) {
						retries--;
						break;
					}
					throw new SandboxFilesystemError(batch.error.errorMessage);
				}
			}
			// The gRPC stream can disconnect before sending eof due to transient network breaks.
			if (!completed) {
				if (retries > 0) {
					retries--;
				} else {
					throw new SandboxFilesystemError(
						"Timed out waiting for filesystem exec completion",
					);
				}
			}
		} catch (err) {
			if (isRetryableGrpc(err) && retries > 0) {
				retries--;
			} else throw err;
		}
	}
	return { chunks, response };
}
