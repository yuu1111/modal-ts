/**
 * @description ハートビートの送信間隔(ミリ秒)
 */
export const ephemeralObjectHeartbeatSleep = 300000;

/**
 * @description ハートビート送信関数の型
 */
export type HeartbeatFunction = () => Promise<unknown>;

/**
 * @description エフェメラルオブジェクトのハートビートを定期送信するマネージャー
 * @property heartbeatFn - ハートビート送信関数
 * @property abortController - ハートビートループの停止制御
 */
export class EphemeralHeartbeatManager {
	private readonly heartbeatFn: HeartbeatFunction;
	private readonly abortController: AbortController;

	/**
	 * @description インスタンス生成と同時にハートビートループを開始する
	 * @param heartbeatFn - ハートビート送信関数
	 */
	constructor(heartbeatFn: HeartbeatFunction) {
		this.heartbeatFn = heartbeatFn;
		this.abortController = new AbortController();

		this.start();
	}

	/**
	 * @description ハートビートループを非同期で開始する
	 */
	private start(): void {
		const signal = this.abortController.signal;
		(async () => {
			while (!signal.aborted) {
				try {
					await this.heartbeatFn();
				} catch {
					// 一時的なエラーでループを停止させない
				}
				await new Promise<void>((resolve) => {
					// unref: ハートビートタイマーがプロセス終了を妨げないようにする
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, ephemeralObjectHeartbeatSleep);
					timer.unref();

					function onAbort(): void {
						clearTimeout(timer);
						resolve();
					}
					signal.addEventListener("abort", onAbort, { once: true });
				});
			}
		})();
	}

	/**
	 * @description ハートビートループを停止する
	 */
	stop(): void {
		this.abortController.abort();
	}
}
