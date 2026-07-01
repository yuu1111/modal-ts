/**
 * @description SDK の出力表示を管理する最小 OutputManager
 */
export class OutputManager {
	static #current: OutputManager | undefined;

	/**
	 * @description 現在の OutputManager を取得する
	 */
	static get(): OutputManager {
		if (!OutputManager.#current) {
			OutputManager.#current = new OutputManager(false);
		}
		return OutputManager.#current;
	}

	/**
	 * @internal
	 */
	static set(manager: OutputManager | undefined): void {
		OutputManager.#current = manager;
	}

	constructor(readonly enabled = true) {}

	/**
	 * @description 標準出力へ message を表示する
	 */
	print(message: unknown): void {
		if (this.enabled) console.log(message);
	}

	/**
	 * @description JSON を標準出力へ表示する
	 */
	printJson(value: unknown): void {
		if (this.enabled) console.log(JSON.stringify(value, undefined, 2));
	}

	/**
	 * @description status 表示用 scope を返す
	 */
	status(message: string): { stop: () => void } {
		this.print(message);
		return { stop: () => {} };
	}
}

/**
 * @description OutputManager を有効にして callback を実行する
 */
export async function enableOutput<T>(
	callback?: () => T | Promise<T>,
): Promise<T | undefined> {
	const previous = OutputManager.get();
	OutputManager.set(new OutputManager(true));
	try {
		if (callback) return await callback();
		return undefined;
	} finally {
		OutputManager.set(previous);
	}
}

export const enable_output = enableOutput;
