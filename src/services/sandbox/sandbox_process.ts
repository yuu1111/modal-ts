import { InvalidError } from "@/core/errors";
import type { TaskCommandRouterClientImpl } from "@/core/grpc/task_command_router_client";
import { FileDescriptor } from "@/generated/modal_proto/api";
import {
	type ModalReadStream,
	type ModalWriteStream,
	streamConsumingIter,
	toModalReadStream,
	toModalWriteStream,
} from "@/utils/streams";
import type { SandboxExecParams } from "./sandbox_config";
import { inputStreamCp, outputStreamCp } from "./sandbox_streams";

/**
 * @description Sandbox内で実行されるプロセスを表し、stdin/stdout/stderrストリームを提供する
 */
export class ContainerProcess<
	R extends string | Uint8Array = string | Uint8Array,
> {
	stdin: ModalWriteStream<R>;
	stdout: ModalReadStream<R>;
	stderr: ModalReadStream<R>;

	readonly #taskId: string;
	readonly #execId: string;
	readonly #commandRouterClient: TaskCommandRouterClientImpl;
	readonly #deadline: number | null;

	/** @internal */
	constructor(
		taskId: string,
		execId: string,
		commandRouterClient: TaskCommandRouterClientImpl,
		params?: SandboxExecParams,
		deadline?: number | null,
	) {
		this.#taskId = taskId;
		this.#execId = execId;
		this.#commandRouterClient = commandRouterClient;
		this.#deadline = deadline ?? null;

		const mode = params?.mode ?? "text";
		const stdout = params?.stdout ?? "pipe";
		const stderr = params?.stderr ?? "pipe";

		this.stdin = toModalWriteStream(
			inputStreamCp<R>(commandRouterClient, taskId, execId),
		);

		const stdoutStream =
			stdout === "ignore"
				? ReadableStream.from([])
				: streamConsumingIter(
						outputStreamCp(
							commandRouterClient,
							taskId,
							execId,
							FileDescriptor.FILE_DESCRIPTOR_STDOUT,
							this.#deadline,
						),
					);

		const stderrStream =
			stderr === "ignore"
				? ReadableStream.from([])
				: streamConsumingIter(
						outputStreamCp(
							commandRouterClient,
							taskId,
							execId,
							FileDescriptor.FILE_DESCRIPTOR_STDERR,
							this.#deadline,
						),
					);

		if (mode === "text") {
			this.stdout = toModalReadStream(
				stdoutStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			) as ModalReadStream<R>;
			this.stderr = toModalReadStream(
				stderrStream.pipeThrough(
					new TextDecoderStream() as TransformStream<Uint8Array, string>,
				),
			) as ModalReadStream<R>;
		} else {
			this.stdout = toModalReadStream(stdoutStream) as ModalReadStream<R>;
			this.stderr = toModalReadStream(stderrStream) as ModalReadStream<R>;
		}
	}

	/**
	 * @description プロセスの終了を待機してexit codeを返す
	 * @returns exit code
	 */
	async wait(): Promise<number> {
		const resp = await this.#commandRouterClient.execWait(
			this.#taskId,
			this.#execId,
			this.#deadline,
		);
		if (resp.code !== undefined) {
			return resp.code;
		} else if (resp.signal !== undefined) {
			return 128 + resp.signal;
		} else {
			throw new InvalidError("Unexpected exit status");
		}
	}
}
