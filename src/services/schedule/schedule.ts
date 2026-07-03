import {
	Schedule as ScheduleProto,
	type Schedule as ScheduleProtoMessage,
} from "@/generated/modal_proto/api";

/**
 * @description Periodic execution schedule for a Modal Function
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
	 * @description Returns the proto representation passed to gRPC
	 */
	toProto(): ScheduleProtoMessage {
		return this.#proto;
	}
}

/**
 * @description Parameters for creating a Cron schedule
 * @property timezone - IANA time zone name @optional @defaultValue "UTC"
 */
export type CronParams = {
	timezone?: string;
};

/**
 * @description Periodic execution schedule in Unix cron format
 */
export class Cron extends Schedule {
	/**
	 * @param cronString - Expression in Unix cron format
	 * @param params - Optional parameters
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
 * @description Parameters for creating a Period schedule
 * @property years - Year interval @optional
 * @property months - Month interval @optional
 * @property weeks - Week interval @optional
 * @property days - Day interval @optional
 * @property hours - Hour interval @optional
 * @property minutes - Minute interval @optional
 * @property seconds - Second interval; fractional values allowed @optional
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
 * @description Periodic execution schedule specified by a relative time interval
 */
export class Period extends Schedule {
	/**
	 * @param params - Duration specification
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
