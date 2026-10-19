/**
 * Binary entry format shared by the Redis handlers (format version 2).
 *
 * Layout: `NCH` (3 bytes) · version (1 byte) · header length (uint32 BE) · header (UTF-8 JSON)
 * · blobs. Every `Buffer`/`Uint8Array` in the value is moved out of the JSON into the blob
 * section and replaced by `{ "__nch_b": [offset, length] }`; a `Map` becomes
 * `{ "__nch_m": [[key, value], ...] }`. Bytes are stored raw, never as base64 or byte arrays.
 *
 * A reader accepts only this magic and version, so an entry in any other format (16.5's JSON,
 * a future version, a foreign value under the same key) reads as a miss, never as data.
 * Clients that can only send and receive strings store the same bytes base64-encoded
 * ({@link encodeEntryString}), which {@link decodeEntry} also reads.
 */

const MAGIC = Buffer.from("NCH", "latin1");
export const FORMAT_VERSION = 2;
const PREAMBLE_LENGTH = MAGIC.length + 1 + 4;

const BLOB_MARKER = "__nch_b";
const MAP_MARKER = "__nch_m";

/**
 * Encode `value` (any JSON-compatible value that may also hold `Buffer`, `Uint8Array` and `Map`).
 */
export function encodeEntry(value: unknown): Buffer {
  const blobs: Uint8Array[] = [];
  let offset = 0;

  // Bytes and Maps are swapped out before `JSON.stringify`, not in a replacer: the replacer runs
  // after `Buffer.prototype.toJSON`, which turns every byte into an array element first.
  const prepare = (current: unknown): unknown => {
    if (current instanceof Uint8Array) {
      blobs.push(current);
      const ref = { [BLOB_MARKER]: [offset, current.byteLength] };
      offset += current.byteLength;
      return ref;
    }
    if (current instanceof Map) {
      return {
        [MAP_MARKER]: Array.from(current.entries(), ([key, item]) => [prepare(key), prepare(item)]),
      };
    }
    if (Array.isArray(current)) return current.map(prepare);
    if (current && typeof current === "object" && !("toJSON" in current)) {
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) copy[key] = prepare(item);
      return copy;
    }
    return current;
  };

  const header = JSON.stringify(prepare(value));

  const headerBytes = Buffer.from(header, "utf8");
  const preamble = Buffer.alloc(PREAMBLE_LENGTH);
  MAGIC.copy(preamble, 0);
  preamble.writeUInt8(FORMAT_VERSION, MAGIC.length);
  preamble.writeUInt32BE(headerBytes.length, MAGIC.length + 1);

  return Buffer.concat([preamble, headerBytes, ...blobs]);
}

/**
 * Encode for a client that only handles strings: the {@link encodeEntry} bytes in base64.
 */
export function encodeEntryString(value: unknown): string {
  return encodeEntry(value).toString("base64");
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
 * Decode an entry written by {@link encodeEntry} or {@link encodeEntryString}. Returns
 * `undefined` for anything else, including other format versions and corrupt entries. Buffers in the result are
 * views of `raw`, not copies.
 */
export function decodeEntry<T = unknown>(raw: Buffer | string | null | undefined): T | undefined {
  if (raw === null || raw === undefined) return undefined;

  let bytes = typeof raw === "string" ? Buffer.from(raw, "latin1") : raw;
  if (!hasPreamble(bytes)) {
    // Written by a string-only client.
    bytes = Buffer.from(typeof raw === "string" ? raw : raw.toString("latin1"), "base64");
    if (!hasPreamble(bytes)) return undefined;
  }

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
    const blob = object[BLOB_MARKER];
    if (Array.isArray(blob) && blob.length === 2) {
      const [start, length] = blob as [number, number];
      if (blobStart + start + length > bytes.length) throw new Error("Truncated cache entry");
      return bytes.subarray(blobStart + start, blobStart + start + length);
    }
    const entries = object[MAP_MARKER];
    if (Array.isArray(entries)) {
      return new Map(entries as [unknown, unknown][]);
    }
    return value;
  }) as T;
}
