/**
 * @packageDocumentation
 * @description
 * 内部生成コード（proto 定義・gRPC クライアント型）を公開する **不安定** なサブパス。
 *
 * ```typescript
 * import { Image, ModalClientDefinition } from "modal-ts/internal";
 * ```
 *
 * このサブパスは何の互換性保証もない不安定な配布物である。
 * バージョン間で削除・改名される可能性が高いため、プロジェクト固有のユーティリティを
 * 実装する場合に限って使用すること。
 */

export type { ModalGrpcClient } from "./client";
export { Any } from "./generated/google/protobuf/any";
export { Empty } from "./generated/google/protobuf/empty";
export { Struct, Value } from "./generated/google/protobuf/struct";
export { Timestamp } from "./generated/google/protobuf/timestamp";
export { StringValue } from "./generated/google/protobuf/wrappers";
// biome-ignore lint/performance/noReExportAll: @internal サブパス向けに生成 proto の全公開面を再エクスポートする
export * from "./generated/modal_proto/api";
