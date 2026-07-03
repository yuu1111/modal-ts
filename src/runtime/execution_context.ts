import { getDefaultClient, type ModalClient } from "@/core/client";

/**
 * @description true when the current process is not running inside a Modal Function
 */
export function isLocal(): boolean {
	return !process.env.MODAL_TASK_ID && !process.env.MODAL_FUNCTION_CALL_ID;
}

/**
 * @description Returns the currently processed input ID
 */
export function currentInputId(): string | undefined {
	return process.env.MODAL_INPUT_ID || undefined;
}

/**
 * @description Returns the currently processed FunctionCall ID
 */
export function currentFunctionCallId(): string | undefined {
	return process.env.MODAL_FUNCTION_CALL_ID || undefined;
}

/**
 * @description Enables interactive mode inside a Modal Function
 */
export async function interact(
	client: ModalClient = getDefaultClient(),
): Promise<void> {
	await client.cpClient.functionStartPtyShell({});
}
