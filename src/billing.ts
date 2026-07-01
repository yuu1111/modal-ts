import { getDefaultClient, type ModalClient } from "@/core/client";
import type { WorkspaceBillingReportItem as WorkspaceBillingReportItemProto } from "@/generated/modal_proto/api";

/**
 * @description Workspace billing report のパラメータ
 */
export type WorkspaceBillingReportParams = {
	start: Date;
	end?: Date;
	resolution?: string;
	tagNames?: string[];
	client?: ModalClient;
};

/**
 * @description Billing report の行
 */
export type BillingReportItem = {
	objectId: string;
	description: string;
	environmentName: string;
	intervalStart: Date;
	cost: string;
	costByResource: Record<string, string>;
	tags: Record<string, string>;
};

/**
 * @description Python の modal.billing.workspace_billing_report 互換の行
 */
export type WorkspaceBillingReportItem = {
	object_id: string;
	description: string;
	environment_name: string;
	interval_start: Date;
	cost: string;
	tags: Record<string, string>;
};

/**
 * @description Workspace usage の billing report を返す
 */
export async function workspaceBillingReport(
	params: WorkspaceBillingReportParams,
): Promise<WorkspaceBillingReportItem[]> {
	const client = params.client ?? getDefaultClient();
	const rows: WorkspaceBillingReportItem[] = [];
	const stream = await client.cpClient.workspaceBillingReport({
		startTimestamp: params.start,
		endTimestamp: params.end ?? new Date(),
		resolution: params.resolution ?? "d",
		tagNames: params.tagNames ?? [],
		environmentIds: [],
		appIds: [],
	});
	for await (const item of stream) {
		const row = billingReportItemFromProto(item);
		rows.push({
			object_id: row.objectId,
			description: row.description,
			environment_name: row.environmentName,
			interval_start: row.intervalStart,
			cost: row.cost,
			tags: row.tags,
		});
	}
	return rows;
}

export const workspace_billing_report = workspaceBillingReport;

export const billing = {
	workspaceBillingReport,
	workspace_billing_report,
};

export function billingReportItemFromProto(
	item: WorkspaceBillingReportItemProto,
): BillingReportItem {
	return {
		objectId: item.objectId,
		description: item.description,
		environmentName: item.environmentName,
		intervalStart: item.interval ?? new Date(0),
		cost: item.cost,
		costByResource: item.costByResource,
		tags: item.tags,
	};
}
