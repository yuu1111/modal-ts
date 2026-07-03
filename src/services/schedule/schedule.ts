import {
	Schedule as ScheduleProto,
	type Schedule as ScheduleProtoMessage,
} from "@/generated/modal_proto/api";

/**
 * Periodic execution schedule for a Modal Function
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
	 * Returns the proto representation passed to gRPC
	 */
	toProto(): ScheduleProtoMessage {
		return this.#proto;
	}
}

/**
 * Parameters for creating a Cron schedule
 * @property timezone - IANA time zone name @defaultValue "UTC"
 */
export type CronParams = {
	timezone?: string;
};

/**
 * Periodic execution schedule in Unix cron format
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
 * Parameters for creating a Period schedule
 * @property years - Year interval
 * @property months - Month interval
 * @property weeks - Week interval
 * @property days - Day interval
 * @property hours - Hour interval
 * @property minutes - Minute interval
 * @property seconds - Second interval; fractional values allowed
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
 * Periodic execution schedule specified by a relative time interval
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
