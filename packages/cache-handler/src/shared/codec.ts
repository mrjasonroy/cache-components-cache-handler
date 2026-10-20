/**
 * Binary entry format shared by the Redis handlers (format version 2).
 *
 * Layout: `NCH` (3 bytes) · version (1 byte) · header length (uint32 BE) · header (UTF-8 JSON)
 * · blobs. Every `Buffer`/`Uint8Array` in the value is moved out of the JSON into the blob
 * section and replaced by `{ "__nch_b": [offset, length] }`; a `Map` becomes
 * `{ "__nch_m": [[key, value], ...] }`. Bytes are stored raw, never as base64 or byte arrays,
 * and bytes repeated within the entry are stored once: several references may point into the
 * same range.
 *
 * A reader accepts only this magic and version, so an entry in any other format (16.5's JSON,
 * a future version, a foreign value under the same key) reads as a miss, never as data.
 *
 * Format version 3 is a compressed v2 entry, written by {@link encodeStored} for entries of 16 KB
 * and over: `NCH` · version 3 · codec (1 byte: 1 = Brotli; 2 is reserved for zstd) · the v2
 * entry's length (uint32 BE) · the compressed v2 entry. {@link decodeStored} reads v2 and v3.
 */

import { isCompressionEnabled } from "./env.js";
import { nodeBuiltin } from "./node-require.js";

// "NCH". A plain Uint8Array, so importing this module never touches `Buffer` (edge bundles).
const MAGIC = Uint8Array.of(0x4e, 0x43, 0x48);
export const FORMAT_VERSION = 2;
const PREAMBLE_LENGTH = MAGIC.length + 1 + 4;

/** Format version of a compressed entry. */
export const COMPRESSED_FORMAT_VERSION = 3;
/** Encoded v2 entries of this many bytes and more are compressed. */
export const COMPRESSION_THRESHOLD_BYTES = 16 * 1024;
const CODEC_BROTLI = 1;
const BROTLI_QUALITY = 4;
const COMPRESSED_PREAMBLE_LENGTH = MAGIC.length + 1 + 1 + 4;
/**
 * The largest entry stored compressed, in uncompressed bytes, and the size of the page memory store
 * (`runtime.ts`), which no larger entry fits in. A v3 entry stating more is a miss, so a corrupt or
 * hostile one cannot make a read inflate up to Redis's 512 MB string limit; a larger entry is
 * stored as v2, which is read at the size Redis holds.
 */
export const MAX_STORED_ENTRY_BYTES = 64 * 1024 * 1024;

const BLOB_MARKER = "__nch_b";
const MAP_MARKER = "__nch_m";

/**
 * Encode `value` (any JSON-compatible value that may also hold `Buffer`, `Uint8Array` and `Map`).
 */
export function encodeEntry(value: unknown): Buffer {
  const { blobs, refs } = layoutBlobs(collectBytes(value));

  // Bytes and Maps are swapped out before `JSON.stringify`, not in a replacer: the replacer runs
  // after `Buffer.prototype.toJSON`, which turns every byte into an array element first.
  const prepare = (current: unknown): unknown => {
    if (current instanceof Uint8Array) return { [BLOB_MARKER]: refs.get(current) };
    if (current instanceof Map) {
      return {
        [MAP_MARKER]: Array.from(current.entries(), ([key, item]) => [prepare(key), prepare(item)]),
      };
    }
    if (Array.isArray(current)) return current.map(prepare);
    if (isPlainObject(current)) {
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) copy[key] = prepare(item);
      return copy;
    }
    return current;
  };

  const header = JSON.stringify(prepare(value));

  const headerBytes = Buffer.from(header, "utf8");
  const preamble = Buffer.alloc(PREAMBLE_LENGTH);
  preamble.set(MAGIC, 0);
  preamble.writeUInt8(FORMAT_VERSION, MAGIC.length);
  preamble.writeUInt32BE(headerBytes.length, MAGIC.length + 1);

  return Buffer.concat([preamble, headerBytes, ...blobs]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !("toJSON" in (value as object));
}

/**
 * Every byte array in `value`, in the order {@link encodeEntry} meets them.
 */
function collectBytes(value: unknown): Uint8Array[] {
  const found: Uint8Array[] = [];
  const walk = (current: unknown): void => {
    if (current instanceof Uint8Array) {
      found.push(current);
    } else if (current instanceof Map) {
      for (const [key, item] of current) {
        walk(key);
        walk(item);
      }
    } else if (Array.isArray(current)) {
      for (const item of current) walk(item);
    } else if (isPlainObject(current)) {
      for (const item of Object.values(current)) walk(item);
    }
  };
  walk(value);
  return found;
}

/**
 * Place each byte array in the blob section and return its `[offset, length]` reference. Bytes
 * already stored are referenced, not stored again: an equal array, or one equal to a stored array
 * minus its first byte. Next 16 writes both into every App Router page entry: `rscData` is the
 * flight data, prefixed with a one-byte marker under Cache Components, and `segmentData['/_full']`
 * is the same flight data (`collect-segment-data.js`), about a quarter of the entry.
 *
 * Longest first, so the longer array is the one stored whichever order the value holds them in.
 * The references are ordinary v2 references, so any v2 reader decodes the entry.
 */
function layoutBlobs(arrays: Uint8Array[]): {
  blobs: Uint8Array[];
  refs: Map<Uint8Array, [number, number]>;
} {
  const blobs: Uint8Array[] = [];
  const refs = new Map<Uint8Array, [number, number]>();
  // Stored arrays by length, so a lookup compares bytes only against arrays it could match.
  const byLength = new Map<number, { bytes: Uint8Array; offset: number }[]>();
  let offset = 0;

  const unique = [...new Set(arrays)].sort((a, b) => b.byteLength - a.byteLength);
  for (const bytes of unique) {
    const length = bytes.byteLength;
    const same = byLength.get(length)?.find((stored) => Buffer.compare(stored.bytes, bytes) === 0);
    if (same) {
      refs.set(bytes, [same.offset, length]);
      continue;
    }
    const prefixed = byLength
      .get(length + 1)
      ?.find((stored) => Buffer.compare(stored.bytes.subarray(1), bytes) === 0);
    if (prefixed) {
      refs.set(bytes, [prefixed.offset + 1, length]);
      continue;
    }
    blobs.push(bytes);
    refs.set(bytes, [offset, length]);
    const stored = byLength.get(length) ?? [];
    stored.push({ bytes, offset });
    byLength.set(length, stored);
    offset += length;
  }
  return { blobs, refs };
}

function hasPreamble(bytes: Buffer): boolean {
  return (
    bytes.length >= PREAMBLE_LENGTH &&
    bytes[0] === MAGIC[0] &&
    bytes[1] === MAGIC[1] &&
    bytes[2] === MAGIC[2]
  );
}

/**
 * The entry's bytes, starting with the magic: `raw` itself, or a string a client handed back as
 * latin1. `undefined` when they do not start with the magic.
 */
function entryBytes(raw: Buffer | string | null | undefined): Buffer | undefined {
  if (raw === null || raw === undefined) return undefined;
  const bytes = typeof raw === "string" ? Buffer.from(raw, "latin1") : raw;
  return hasPreamble(bytes) ? bytes : undefined;
}

/**
 * Decode an entry written by {@link encodeEntry}. Returns
 * `undefined` for anything else, including other format versions and corrupt entries. Buffers in the result are
 * views of `raw`, not copies.
 */
export function decodeEntry<T = unknown>(raw: Buffer | string | null | undefined): T | undefined {
  const bytes = entryBytes(raw);
  if (!bytes) return undefined;

  if (bytes.readUInt8(MAGIC.length) !== FORMAT_VERSION) return undefined;
  const headerLength = bytes.readUInt32BE(MAGIC.length + 1);
  const blobStart = PREAMBLE_LENGTH + headerLength;
  if (blobStart > bytes.length) return undefined;

  const header = bytes.toString("utf8", PREAMBLE_LENGTH, blobStart);
  try {
    return parseHeader<T>(header, bytes, blobStart);
  } catch {
    // A corrupt or truncated entry is a miss, like any other unreadable value.
    return undefined;
  }
}

function parseHeader<T>(header: string, bytes: Buffer, blobStart: number): T {
  return JSON.parse(header, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    // The encoder writes a marker as an array under the marker key: an object without one is
    // ordinary JSON (a header named `__nch_b`). A marker must be alone and in the encoder's shape;
    // anything else is a corrupt entry (thrown, so a miss).
    if (Array.isArray(object[BLOB_MARKER])) return blobAt(object, bytes, blobStart);
    const entries = object[MAP_MARKER];
    if (Array.isArray(entries)) {
      if (
        Object.keys(object).length !== 1 ||
        !entries.every((entry) => Array.isArray(entry) && entry.length === 2)
      ) {
        throw new Error("Corrupt cache entry: bad map");
      }
      return new Map(entries as [unknown, unknown][]);
    }
    return value;
  }) as T;
}

/**
 * The bytes a `{ "__nch_b": [start, length] }` reference names: whole, non-negative numbers that
 * stay inside the blob section, or a throw.
 */
function blobAt(object: Record<string, unknown>, bytes: Buffer, blobStart: number): Buffer {
  const reference = object[BLOB_MARKER];
  const blobLength = bytes.length - blobStart;
  if (Object.keys(object).length !== 1 || !Array.isArray(reference) || reference.length !== 2) {
    throw new Error("Corrupt cache entry: bad blob reference");
  }
  const [start, length] = reference as unknown[];
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    (start as number) < 0 ||
    (length as number) < 0 ||
    (start as number) + (length as number) > blobLength
  ) {
    throw new Error("Corrupt cache entry: bad blob reference");
  }
  return bytes.subarray(
    blobStart + (start as number),
    blobStart + (start as number) + (length as number),
  );
}

type Zlib = typeof import("node:zlib");

/**
 * Encode `value` as it is stored in Redis: the {@link encodeEntry} v2 bytes, compressed with Brotli
 * (quality 4, off the event loop) into a v3 entry when they are 16 KB or more. Stays v2 with
 * `CACHE_COMPRESSION=off`, above {@link MAX_STORED_ENTRY_BYTES}, and when compressing would not
 * make the entry smaller.
 */
export async function encodeStored(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const entry = encodeEntry(value);
  if (
    entry.length < COMPRESSION_THRESHOLD_BYTES ||
    entry.length > MAX_STORED_ENTRY_BYTES ||
    !isCompressionEnabled(env)
  ) {
    return entry;
  }

  const zlib = nodeBuiltin<Zlib>("node:zlib");
  const compressed = await new Promise<Buffer>((resolve, reject) => {
    zlib.brotliCompress(
      entry,
      {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.length,
        },
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
  if (COMPRESSED_PREAMBLE_LENGTH + compressed.length >= entry.length) return entry;

  const preamble = Buffer.alloc(COMPRESSED_PREAMBLE_LENGTH);
  preamble.set(MAGIC, 0);
  preamble.writeUInt8(COMPRESSED_FORMAT_VERSION, MAGIC.length);
  preamble.writeUInt8(CODEC_BROTLI, MAGIC.length + 1);
  preamble.writeUInt32BE(entry.length, MAGIC.length + 2);
  return Buffer.concat([preamble, compressed]);
}

/**
 * Decode an entry written by {@link encodeStored} (v3 or v2) or {@link encodeEntry}. Returns
 * `undefined`, never throws, for anything else: another format, an unknown codec, or a corrupt,
 * truncated or wrongly sized entry.
 */
export async function decodeStored<T = unknown>(
  raw: Buffer | string | null | undefined,
): Promise<T | undefined> {
  const bytes = entryBytes(raw);
  if (!bytes) return undefined;
  if (bytes.readUInt8(MAGIC.length) !== COMPRESSED_FORMAT_VERSION) return decodeEntry<T>(bytes);

  if (bytes.length <= COMPRESSED_PREAMBLE_LENGTH) return undefined;
  if (bytes.readUInt8(MAGIC.length + 1) !== CODEC_BROTLI) return undefined;
  const length = bytes.readUInt32BE(MAGIC.length + 2);
  if (length < PREAMBLE_LENGTH || length > MAX_STORED_ENTRY_BYTES) return undefined;

  const zlib = nodeBuiltin<Zlib>("node:zlib");
  const entry = await new Promise<Buffer | undefined>((resolve) => {
    // `maxOutputLength` stops a corrupt entry from inflating past its stated length.
    zlib.brotliDecompress(
      bytes.subarray(COMPRESSED_PREAMBLE_LENGTH),
      { maxOutputLength: length },
      (error, result) => resolve(error ? undefined : result),
    );
  });
  if (!entry || entry.length !== length) return undefined;
  // Only a v2 entry: a v3 entry inside a v3 entry is corrupt.
  return decodeEntry<T>(entry);
}

/**
 * Sizes for the debug log of a stored entry: `bytes`, its v2 encoding (uncompressed), and
 * `encodedBytes`, what Redis holds.
 */
export function storedSizes(stored: Buffer): { bytes: number; encodedBytes: number } {
  const compressed =
    stored.length >= COMPRESSED_PREAMBLE_LENGTH &&
    hasPreamble(stored) &&
    stored[MAGIC.length] === COMPRESSED_FORMAT_VERSION;
  return {
    bytes: compressed ? stored.readUInt32BE(MAGIC.length + 2) : stored.length,
    encodedBytes: stored.length,
  };
}
