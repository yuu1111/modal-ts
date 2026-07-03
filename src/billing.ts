import { getDefaultClient, type ModalClient } from "@/core/client";
import {
	WorkspaceBillingManager,
	type WorkspaceBillingReportRow,
} from "@/services/workspace/workspace";

/**
 * Parameters for a workspace billing report
 */
export type WorkspaceBillingReportParams = {
	start: Date;
	end?: Date;
	resolution?: string;
	tagNames?: string[];
	client?: ModalClient;
};

/**
 * A billing report row
 */
export type BillingReportItem = WorkspaceBillingReportRow;

/**
 * Row compatible with Python's modal.billing.workspace_billing_report
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
 * Returns a billing report for workspace usage
 */
export async function workspaceBillingReport(
	params: WorkspaceBillingReportParams,
): Promise<WorkspaceBillingReportItem[]> {
	const client = params.client ?? getDefaultClient();
	const manager = new WorkspaceBillingManager(client);
	const rows = await manager.report(params);
	return rows.map(workspaceBillingReportItemFromRow);
}

export const workspace_billing_report = workspaceBillingReport;

export const billing = {
	workspaceBillingReport,
	workspace_billing_report,
};

function workspaceBillingReportItemFromRow(
	row: WorkspaceBillingReportRow,
): WorkspaceBillingReportItem {
	return {
		object_id: row.objectId,
		description: row.description,
		environment_name: row.environmentName,
		interval_start: row.intervalStart,
		cost: row.cost,
		tags: row.tags,
	};
}
