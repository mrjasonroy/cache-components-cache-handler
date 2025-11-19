/**
 * Buffer conversion utilities for Next.js 15+ compatibility
 * Next.js 15 changed body/rscData from strings to Buffers
 */

/**
 * Convert a value to base64 string if it's a Buffer
 * Used when storing cache values (e.g., in Redis)
 *
 * @param value - Value that might be a Buffer
 * @returns Base64 string if Buffer, original value otherwise
 */
export function bufferToString(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map(bufferToString);
  }

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = bufferToString(val);
    }
    return result;
  }

  return value;
}

/**
 * Convert a base64 string back to Buffer if it was originally a Buffer
 * Used when retrieving cache values (e.g., from Redis)
 *
 * This is a simplified version - in production you'd need to track
 * which fields were originally Buffers
 *
 * @param value - Value that might be a base64 string
 * @param isBuffer - Whether this value should be converted to Buffer
 * @returns Buffer if isBuffer is true, original value otherwise
 */
export function stringToBuffer(value: string, isBuffer: boolean): Buffer | string {
  if (isBuffer && typeof value === "string") {
    return Buffer.from(value, "base64");
  }
  return value;
}
