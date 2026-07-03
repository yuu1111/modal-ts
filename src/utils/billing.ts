import type { WorkspaceBillingReportItem } from "@/generated/modal_proto/api";

/**
 * Billing report row returned by workspace-scoped billing APIs.
 */
export type BillingReportRow = {
	objectId: string;
	description: string;
	environmentName: string;
	intervalStart: Date;
	cost: string;
	costByResource: Record<string, string>;
	tags: Record<string, string>;
};

/**
 * Converts a billing report proto item into a public row shape.
 *
 * @param item - Billing report proto item
 * @returns Billing report row
 */
export function billingReportRowFromProto(
	item: WorkspaceBillingReportItem,
): BillingReportRow {
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
