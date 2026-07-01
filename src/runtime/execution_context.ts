import { getDefaultClient, type ModalClient } from "@/core/client";

/**
 * @description 現在の process が Modal Function 実行中でなければ true
 */
export function isLocal(): boolean {
	return !process.env.MODAL_TASK_ID && !process.env.MODAL_FUNCTION_CALL_ID;
}

/**
 * @description 現在処理中の input ID を返す
 */
export function currentInputId(): string | undefined {
	return process.env.MODAL_INPUT_ID || undefined;
}

/**
 * @description 現在処理中の FunctionCall ID を返す
 */
export function currentFunctionCallId(): string | undefined {
	return process.env.MODAL_FUNCTION_CALL_ID || undefined;
}

/**
 * @description Modal Function 内の対話モードを有効化する
 */
export async function interact(
	client: ModalClient = getDefaultClient(),
): Promise<void> {
	await client.cpClient.functionStartPtyShell({});
}
