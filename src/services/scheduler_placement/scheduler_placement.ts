import {
	SchedulerPlacement as SchedulerPlacementProto,
	type SchedulerPlacement as SchedulerPlacementProtoMessage,
} from "@/generated/modal_proto/api";

/**
 * @description Parameters for creating SchedulerPlacement
 * @property region - Preferred region or regions for execution @optional
 * @property zone - Preferred zone for execution @optional
 * @property spot - true prefers spot, false prefers on-demand @optional
 * @property instanceType - Preferred instance type or types for execution @optional
 * @property nonpreemptible - Requests non-preemptible execution for a Function @optional
 */
export type SchedulerPlacementParams = {
	region?: string | string[];
	zone?: string;
	spot?: boolean;
	instanceType?: string | string[];
	nonpreemptible?: boolean;
};

/**
 * @description Scheduling constraints for Functions and Sandboxes
 */
export class SchedulerPlacement {
	readonly #proto: SchedulerPlacementProtoMessage;

	/**
	 * @param params - Scheduling constraints
	 */
	constructor(params: SchedulerPlacementParams = {}) {
		const regions =
			typeof params.region === "string"
				? [params.region]
				: (params.region ?? []);
		const instanceTypes =
			typeof params.instanceType === "string"
				? [params.instanceType]
				: (params.instanceType ?? []);
		const lifecycle =
			params.spot === undefined
				? undefined
				: params.spot
					? "spot"
					: "on-demand";

		this.#proto = SchedulerPlacementProto.create({
			regions,
			Zone: params.zone,
			Lifecycle: lifecycle,
			InstanceTypes: instanceTypes,
			nonpreemptible: params.nonpreemptible ?? false,
		});
	}

	/**
	 * @description Returns the proto representation passed to gRPC
	 */
	toProto(): SchedulerPlacementProtoMessage {
		return this.#proto;
	}
}
