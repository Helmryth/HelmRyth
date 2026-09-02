/** JSON values accepted at Companion network and persistence boundaries. */
export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** Values the sidecar may serialize after constructing them internally. */
export type JsonResponseBody = JsonPrimitive | object;

/** JSON.parse without a reviver can only produce JSON-compatible values. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/** Return a JSON object without treating arrays or primitives as records. */
export function jsonObject(value: JsonValue): JsonObject | null {
  if (value === null || Array.isArray(value) || Object(value) !== value) return null;
  // SAFETY: the checks above exclude every JsonValue variant except JsonObject.
  return value as JsonObject;
}

/** Return a string primitive without using coercion as validation. */
export function jsonString(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null || Array.isArray(value) || Object(value) === value) return null;
  const text = String(value);
  return text === value ? text : null;
}

/** Return a finite number primitive, or the supplied fallback. */
export function jsonNumber(value: JsonValue | undefined, fallback: number): number {
  if (value === undefined || value === null || Array.isArray(value) || Object(value) === value) return fallback;
  const number = Number(value);
  return number === value && Number.isFinite(number) ? number : fallback;
}
