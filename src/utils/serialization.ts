/**
 * CBOR serialization for Modal
 *
 * Wraps cbor-x with settings compatible with Python's CBOR implementation.
 */

import { Decoder, Encoder, type Options } from "cbor-x";

/**
 * Extended interface for options not represented in cbor-x types
 * @property useTag259ForMaps - Whether to use CBOR tag 259 when encoding Maps
 */
interface ExtendedOptions extends Options {
	useTag259ForMaps?: boolean;
}

/**
 * Shared options for compatibility with Python's CBOR implementation
 */
const cborOptions: ExtendedOptions = {
	mapsAsObjects: true,
	useRecords: false,
	tagUint8Array: false,
	useTag259ForMaps: false,
};

/**
 * Singleton CBOR encoder instance
 */
const encoder = new Encoder(cborOptions);

/**
 * Singleton CBOR decoder instance
 */
const decoder = new Decoder(cborOptions);

/**
 * Encodes a JavaScript value into CBOR bytes
 * @param value - Value to encode
 * @returns CBOR-encoded bytes
 */
export function cborEncode(value: unknown): Buffer {
	return encoder.encode(value);
}

/**
 * Decodes CBOR bytes into a JavaScript value
 * @param data - Data to decode
 * @returns Decoded value
 */
export function cborDecode(data: Buffer | Uint8Array): unknown {
	return decoder.decode(data);
}
