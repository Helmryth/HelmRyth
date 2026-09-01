import { describe, expect, it } from "vitest";

import { firstLeasedImportBot, leasedRoutineTarget } from "./import-undo-lease.ts";

describe("pending crew-undo lease boundary", () => {
  const leases = new Set(["operator-removing"]);

  it("blocks both new and edited crew rosters from attaching a leased operator", () => {
    expect(firstLeasedImportBot(["operator-safe", "operator-removing"], leases)).toBe("operator-removing");
    expect(firstLeasedImportBot(["operator-safe"], leases)).toBeNull();
  });

  it("blocks cadence create and patch payloads that retarget to a leased operator", () => {
    expect(leasedRoutineTarget({ botId: "operator-removing", name: "Daily check" }, leases))
      .toBe("operator-removing");
    expect(leasedRoutineTarget({ botId: "operator-safe" }, leases)).toBeNull();
    expect(leasedRoutineTarget({ botId: 42 }, leases)).toBeNull();
    expect(leasedRoutineTarget(null, leases)).toBeNull();
  });
});
