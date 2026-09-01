import { z } from "zod";

const boundaryValueSchema = z.unknown();
type BoundaryValue = z.input<typeof boundaryValueSchema>;

const routineTargetSchema = z.object({ botId: z.string().optional() }).passthrough();

/** Return the first operator whose durable import undo currently owns it. */
export function firstLeasedImportBot(
  botIds: Iterable<string>,
  leases: ReadonlySet<string>,
): string | null {
  for (const botId of botIds) {
    if (leases.has(botId)) return botId;
  }
  return null;
}

/** Decode only the effective cadence target needed by the lease boundary. */
export function leasedRoutineTarget(
  value: BoundaryValue,
  leases: ReadonlySet<string>,
): string | null {
  const parsed = routineTargetSchema.safeParse(value);
  const botId = parsed.success ? parsed.data.botId : undefined;
  return botId && leases.has(botId) ? botId : null;
}
