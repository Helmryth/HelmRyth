import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { jsonObject, jsonString, parseJson, type JsonObject, type JsonValue } from "../src/json.ts";

/** Port chosen for a TCP server after its listen callback has fired. */
export function serverPort(server: Server): number {
  const address = server.address();
  if (!address || !Object.prototype.hasOwnProperty.call(address, "port")) {
    throw new Error("expected a listening TCP server");
  }
  // SAFETY: the own `port` check excludes the string pipe-address variant;
  // the remaining Node Server.address() variant is AddressInfo.
  return (address as AddressInfo).port;
}

/** Parse a Fetch response whose API contract requires a JSON object. */
export async function responseObject(response: Response): Promise<JsonObject> {
  const value = parseJson(await response.text());
  const object = jsonObject(value);
  if (!object) throw new Error("expected a JSON object response");
  return object;
}

export function requiredObject(value: JsonValue | undefined, field: string): JsonObject {
  if (value === undefined) throw new Error(`missing ${field}`);
  const object = jsonObject(value);
  if (!object) throw new Error(`expected ${field} to be an object`);
  return object;
}

export function requiredArray(value: JsonValue | undefined, field: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`expected ${field} to be an array`);
  return value;
}

export function requiredString(value: JsonValue | undefined, field: string): string {
  const text = jsonString(value);
  if (text === null) throw new Error(`expected ${field} to be a string`);
  return text;
}
