import {
	Schedule as ScheduleProto,
	type Schedule as ScheduleProtoMessage,
} from "@/generated/modal_proto/api";

/**
 * @description Modal Function の定期実行スケジュール
 */
export abstract class Schedule {
	readonly #proto: ScheduleProtoMessage;

	/**
	 * @internal
	 */
	protected constructor(proto: ScheduleProtoMessage) {
		this.#proto = proto;
	}

	/**
	 * @description gRPC に渡す proto 表現を返す
	 */
	toProto(): ScheduleProtoMessage {
		return this.#proto;
	}
}

/**
 * @description Cron スケジュールの作成パラメータ
 * @property timezone - IANA タイムゾーン名 @optional @defaultValue "UTC"
 */
export type CronParams = {
	timezone?: string;
};

/**
 * @description Unix cron 形式の定期実行スケジュール
 */
export class Cron extends Schedule {
	/**
	 * @param cronString - Unix cron 形式の式
	 * @param params - オプションパラメータ
	 */
	constructor(cronString: string, params: CronParams = {}) {
		super(
			ScheduleProto.create({
				cron: {
					cronString,
					timezone: params.timezone ?? "UTC",
				},
			}),
		);
	}
}

/**
 * @description Period スケジュールの作成パラメータ
 * @property years - 年間隔 @optional
 * @property months - 月間隔 @optional
 * @property weeks - 週間隔 @optional
 * @property days - 日間隔 @optional
 * @property hours - 時間間隔 @optional
 * @property minutes - 分間隔 @optional
 * @property seconds - 秒間隔。小数可 @optional
 */
export type PeriodParams = {
	years?: number;
	months?: number;
	weeks?: number;
	days?: number;
	hours?: number;
	minutes?: number;
	seconds?: number;
};

/**
 * @description 相対時間間隔で指定する定期実行スケジュール
 */
export class Period extends Schedule {
	/**
	 * @param params - 期間指定
	 */
	constructor(params: PeriodParams) {
		super(
			ScheduleProto.create({
				period: {
					years: params.years ?? 0,
					months: params.months ?? 0,
					weeks: params.weeks ?? 0,
					days: params.days ?? 0,
					hours: params.hours ?? 0,
					minutes: params.minutes ?? 0,
					seconds: params.seconds ?? 0,
				},
			}),
		);
	}
}
