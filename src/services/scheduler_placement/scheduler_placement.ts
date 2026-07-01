import {
	SchedulerPlacement as SchedulerPlacementProto,
	type SchedulerPlacement as SchedulerPlacementProtoMessage,
} from "@/generated/modal_proto/api";

/**
 * @description SchedulerPlacement の作成パラメータ
 * @property region - 実行を希望するリージョンまたはリージョン配列 @optional
 * @property zone - 実行を希望するゾーン @optional
 * @property spot - true なら spot、false なら on-demand を希望 @optional
 * @property instanceType - 実行を希望するインスタンスタイプまたは配列 @optional
 * @property nonpreemptible - Function でプリエンプト不可実行を要求する @optional
 */
export type SchedulerPlacementParams = {
	region?: string | string[];
	zone?: string;
	spot?: boolean;
	instanceType?: string | string[];
	nonpreemptible?: boolean;
};

/**
 * @description Function や Sandbox のスケジューリング制約
 */
export class SchedulerPlacement {
	readonly #proto: SchedulerPlacementProtoMessage;

	/**
	 * @param params - スケジューリング制約
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
	 * @description gRPC に渡す proto 表現を返す
	 */
	toProto(): SchedulerPlacementProtoMessage {
		return this.#proto;
	}
}
