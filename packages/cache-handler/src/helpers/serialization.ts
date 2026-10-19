/**
 * JSON serialization helpers for cache values containing Map and Buffer instances.
 *
 * Next.js 16 APP_PAGE entries store `segmentData` as a Map<string, Buffer>
 * and `rscData` as a Buffer. Plain JSON.stringify converts Maps to `{}` and
 * loses Buffer identity, so custom replacer/reviver functions are needed.
 */

type NodeBufferJson = {
  type: "Buffer";
  data: number[];
};

function isByte(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function isNodeBufferJson(value: unknown): value is NodeBufferJson {
  if (!value || typeof value !== "object") return false;

  const obj = value as Record<string, unknown>;
  return obj.type === "Buffer" && Array.isArray(obj.data) && obj.data.every(isByte);
}

/**
 * Custom JSON replacer that serializes Map and Buffer instances.
 * - Maps become `{ __serialized_type: "Map", entries: [...] }`
 * - Buffers become `{ __serialized_type: "Buffer", data: "<base64>" }`
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return {
      __serialized_type: "Map",
      entries: Array.from(value.entries()),
    };
  }
  if (Buffer.isBuffer(value)) {
    return {
      __serialized_type: "Buffer",
      data: value.toString("base64"),
    };
  }
  // Node calls Buffer.toJSON() before the replacer — nested Buffers arrive as
  // `{ type: "Buffer", data: number[] }` instead of a Buffer instance.
  if (isNodeBufferJson(value)) {
    return {
      __serialized_type: "Buffer",
      data: Buffer.from(value.data).toString("base64"),
    };
  }
  return value;
}

/**
 * Custom JSON reviver that restores Map and Buffer instances.
 * Also handles backward-compat with Node's native Buffer JSON
 * representation `{ type: "Buffer", data: [byte, ...] }`.
 */
export function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if (
      obj.__serialized_type === "Map" &&
      Array.isArray(obj.entries) &&
      obj.entries.every((e) => Array.isArray(e) && e.length === 2)
    ) {
      return new Map(obj.entries as [unknown, unknown][]);
    }

    if (obj.__serialized_type === "Buffer" && typeof obj.data === "string") {
      return Buffer.from(obj.data, "base64");
    }

    // Backward compat: Node's Buffer.toJSON() format.
    // Guard with number[] check to avoid false-positives on user data
    // that happens to have { type: "Buffer", data: [...] } shape.
    if (isNodeBufferJson(obj)) {
      return Buffer.from(obj.data);
    }
  }
  return value;
}
