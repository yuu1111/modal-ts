/**
 * @description Modal 向け CBOR シリアライゼーション
 *
 * Python 側の CBOR 実装と互換性を保つ設定で cbor-x をラップする
 */

import { Decoder, Encoder, type Options } from "cbor-x";

/**
 * @description cbor-x の型定義に未反映のオプションを含む拡張インターフェース
 * @property useTag259ForMaps - Map エンコード時に CBOR tag 259 を使うか
 */
interface ExtendedOptions extends Options {
	useTag259ForMaps?: boolean;
}

/**
 * @description Python CBOR 実装と互換性を保つための共通オプション
 */
const cborOptions: ExtendedOptions = {
	mapsAsObjects: true,
	useRecords: false,
	tagUint8Array: false,
	useTag259ForMaps: false,
};

/**
 * @description CBOR エンコーダのシングルトンインスタンス
 */
const encoder = new Encoder(cborOptions);

/**
 * @description CBOR デコーダのシングルトンインスタンス
 */
const decoder = new Decoder(cborOptions);

/**
 * @description JavaScript の値を CBOR バイト列にエンコードする
 * @param value - エンコード対象
 * @returns CBOR エンコード済みバイト列
 */
export function cborEncode(value: unknown): Buffer {
	return encoder.encode(value);
}

/**
 * @description CBOR バイト列を JavaScript の値にデコードする
 * @param data - デコード対象
 * @returns デコード済みの値
 */
export function cborDecode(data: Buffer | Uint8Array): unknown {
	return decoder.decode(data);
}
