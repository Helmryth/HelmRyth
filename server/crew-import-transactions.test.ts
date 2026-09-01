import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CrewImportTransactions,
  type CrewImportCallbacks,
  type CrewImportJournalFile,
  type CrewImportReceipt,
} from "./crew-import-transactions.ts";

type State = { crews: string[]; archives: string[] };
type Result = { crewId: string; importedMembers: number };
type Archived = { crewId: string; previousStatus: string };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "helmryth-crew-import-"));
  temporaryDirectories.push(directory);
  return { directory, journalPath: join(directory, "transactions.json") };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function callbacks(
  state: State,
  mutate = vi.fn(async () => {
    state.crews.push("crew-new");
    state.archives.push("crew-old");
    return {
      result: { crewId: "crew-new", importedMembers: 3 },
      artifactIds: ["crew-new", "member-1", "member-2", "member-3"],
      archivedPriorStates: [{ crewId: "crew-old", previousStatus: "active" }],
    } satisfies { result: Result; artifactIds: string[]; archivedPriorStates: Archived[] };
  }),
): CrewImportCallbacks<State, Result, Archived[]> {
  return {
    snapshot: vi.fn(async () => clone(state)),
    restore: vi.fn(async ({ snapshot }) => {
      state.crews = [...snapshot.crews];
      state.archives = [...snapshot.archives];
    }),
    rollback: vi.fn(async ({ snapshot }) => {
      state.crews = [...snapshot.crews];
      state.archives = [...snapshot.archives];
    }),
    mutate,
    undo: vi.fn(async ({ snapshot }) => {
      state.crews = [...snapshot.crews];
      state.archives = [...snapshot.archives];
    }),
  };
}

function request(fingerprint = "sha256:payload-one") {
  return { idempotencyKey: "import-request-0001", fingerprint };
}

describe("CrewImportTransactions", () => {
  it("durably prepares before mutation and returns the committed receipt on restart", async () => {
    const { journalPath } = setup();
    const state: State = { crews: ["crew-old"], archives: [] };
    let preparedWasVisible = false;
    const mutate = vi.fn(async () => {
      // SAFETY: the service wrote this file from CrewImportJournalFile immediately before mutate.
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as CrewImportJournalFile;
      preparedWasVisible = journal.transactions[request().idempotencyKey]?.state === "prepared";
      state.crews.push("crew-new");
      return {
        result: { crewId: "crew-new", importedMembers: 3 },
        artifactIds: ["crew-new"],
        archivedPriorStates: [{ crewId: "crew-old", previousStatus: "active" }],
      };
    });
    const service = new CrewImportTransactions<State, Result, Archived[]>({
      journalPath,
      now: () => "2026-08-30T10:00:00.000Z",
      idFactory: () => "transaction-1",
    });

    const receipt = await service.execute(request(), callbacks(state, mutate));

    expect(preparedWasVisible).toBe(true);
    expect(receipt).toEqual({
      transactionId: "transaction-1",
      idempotencyKey: "import-request-0001",
      fingerprint: "sha256:payload-one",
      result: { crewId: "crew-new", importedMembers: 3 },
      artifactIds: ["crew-new"],
      archivedPriorStates: [{ crewId: "crew-old", previousStatus: "active" }],
      committedAt: "2026-08-30T10:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(journalPath, "utf8"))).toMatchObject({
      version: 1,
      transactions: { "import-request-0001": { state: "committed", receipt } },
    });
    expect(service.committedReceipts()).toEqual([receipt]);
    expect(service.requestForTransaction(receipt.transactionId)).toEqual(request());
    expect(service.requestForTransaction("missing-transaction")).toBeNull();

    const restarted = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    const retryMutation = vi.fn();
    await expect(restarted.execute(request(), callbacks(state, retryMutation))).resolves.toEqual(receipt);
    expect(retryMutation).not.toHaveBeenCalled();
  });

  it("serializes imports, coalesces the same key, and rejects a conflicting fingerprint", async () => {
    const { journalPath } = setup();
    const state: State = { crews: [], archives: [] };
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutate = vi.fn(async () => {
      await gate;
      state.crews.push("crew-new");
      return {
        result: { crewId: "crew-new", importedMembers: 3 },
        artifactIds: ["crew-new"],
        archivedPriorStates: [],
      };
    });
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    const handlers = callbacks(state, mutate);

    const first = service.execute(request(), handlers);
    const duplicate = service.execute(request(), handlers);
    const conflict = service.execute(request("sha256:different"), handlers);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    release();

    const [firstReceipt, duplicateReceipt] = await Promise.all([first, duplicate]);
    expect(duplicateReceipt).toEqual(firstReceipt);
    expect(mutate).toHaveBeenCalledOnce();
    await expect(conflict).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("restores the exact snapshot after a failed mutation and permits an exact retry", async () => {
    const { journalPath } = setup();
    const initial: State = { crews: ["crew-old"], archives: [] };
    const state = clone(initial);
    const failedMutation = vi.fn(async () => {
      state.crews.push("partial-crew");
      state.archives.push("crew-old");
      throw new Error("member import failed");
    });
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });

    await expect(service.execute(request(), callbacks(state, failedMutation))).rejects.toThrow(
      "member import failed",
    );
    expect(state).toEqual(initial);
    expect(service.inspect(request().idempotencyKey)).toMatchObject({ state: "rolled_back" });

    const retry = callbacks(state);
    await expect(service.execute(request(), retry)).resolves.toMatchObject({
      result: { crewId: "crew-new" },
    });
    expect(retry.mutate).toHaveBeenCalledOnce();
  });

  it("rolls mutation back when the committed receipt cannot be persisted", async () => {
    const { journalPath } = setup();
    const initial: State = { crews: ["crew-old"], archives: [] };
    const state = clone(initial);
    let failCommit = true;
    const service = new CrewImportTransactions<State, Result, Archived[]>({
      journalPath,
      fault: ({ point }) => {
        if (point === "before_commit_persist" && failCommit) {
          failCommit = false;
          throw new Error("disk unavailable");
        }
      },
    });

    await expect(service.execute(request(), callbacks(state))).rejects.toThrow("disk unavailable");
    expect(state).toEqual(initial);
    expect(service.inspect(request().idempotencyKey)).toMatchObject({ state: "rolled_back" });
  });

  it("undoes a committed import once and returns the same durable undo receipt on retries", async () => {
    const { journalPath } = setup();
    const initial: State = { crews: ["crew-old"], archives: [] };
    const state = clone(initial);
    const service = new CrewImportTransactions<State, Result, Archived[]>({
      journalPath,
      now: () => "2026-08-30T11:00:00.000Z",
      idFactory: () => "transaction-undo",
    });
    const handlers = callbacks(state);
    const receipt = await service.execute(request(), handlers);

    const undone = await service.undo(request(), handlers);
    const retried = await service.undo(request(), handlers);

    expect(state).toEqual(initial);
    expect(handlers.undo).toHaveBeenCalledOnce();
    expect(undone).toEqual({ receipt, undoneAt: "2026-08-30T11:00:00.000Z" });
    expect(retried).toEqual(undone);
    expect(service.inspect(request().idempotencyKey)).toMatchObject({
      state: "undone",
      undoReceipt: undone,
    });
    expect(service.committedReceipts()).toEqual([]);
    expect(service.requestForTransaction(receipt.transactionId)).toEqual(request());
  });

  it("restores the committed state when undo fails and allows a later retry", async () => {
    const { journalPath } = setup();
    const state: State = { crews: ["crew-old"], archives: [] };
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    const handlers = callbacks(state);
    await service.execute(request(), handlers);
    const committedState = clone(state);
    const failedUndo = vi.fn(async () => {
      state.crews = [];
      throw new Error("undo interrupted");
    });

    await expect(service.undo(request(), { ...handlers, undo: failedUndo })).rejects.toThrow(
      "undo interrupted",
    );
    expect(state).toEqual(committedState);
    expect(service.inspect(request().idempotencyKey)).toMatchObject({ state: "committed" });

    await expect(service.undo(request(), handlers)).resolves.toMatchObject({
      receipt: { transactionId: expect.any(String) },
    });
  });

  it("keeps the durable pre-undo snapshot when final undo persistence fails", async () => {
    const { journalPath } = setup();
    const initial: State = { crews: ["crew-old"], archives: [] };
    const state = clone(initial);
    let failFinalCommit = true;
    const service = new CrewImportTransactions<State, Result, Archived[]>({
      journalPath,
      fault: ({ point }) => {
        if (point === "before_undo_commit_persist") throw new Error("undo receipt disk gap");
        if (point === "before_undo_rollback_commit_persist" && failFinalCommit) {
          failFinalCommit = false;
          throw new Error("committed receipt write failed");
        }
      },
    });
    const handlers = callbacks(state);
    await service.execute(request(), handlers);
    const committedState = clone(state);

    await expect(service.undo(request(), handlers)).rejects.toThrow("Crew import undo failed");
    expect(state).toEqual(committedState);
    expect(service.inspect(request().idempotencyKey)).toMatchObject({
      state: "undo_compensation_pending",
      undoSnapshot: committedState,
    });

    const restarted = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    const restartHandlers = callbacks(state);
    await expect(restarted.recover(restartHandlers)).resolves.toEqual({ rolledBack: 0, undone: 1 });
    expect(restartHandlers.restore).toHaveBeenCalledWith({
      snapshot: committedState,
      receipt: expect.objectContaining({ transactionId: expect.any(String) }),
    });
    expect(restartHandlers.undo).not.toHaveBeenCalled();
    expect(restarted.inspect(request().idempotencyKey)).toMatchObject({ state: "committed" });
  });

  it("recovers prepared work and restores the pre-undo snapshot instead of replaying undo", async () => {
    const { journalPath } = setup();
    const original: State = { crews: ["crew-old"], archives: [] };
    const committed: State = { crews: ["crew-old", "crew-new"], archives: ["crew-old"] };
    const receipt: CrewImportReceipt<Result, Archived[]> = {
      transactionId: "transaction-2",
      idempotencyKey: "undoing-key",
      fingerprint: "sha256:undoing",
      result: { crewId: "crew-new", importedMembers: 3 },
      artifactIds: ["crew-new"],
      archivedPriorStates: [{ crewId: "crew-old", previousStatus: "active" }],
      committedAt: "2026-08-30T09:00:00.000Z",
    };
    const journal: CrewImportJournalFile<State, Result, Archived[]> = {
      version: 1,
      transactions: {
        "prepared-key": {
          state: "prepared",
          transactionId: "transaction-1",
          idempotencyKey: "prepared-key",
          fingerprint: "sha256:prepared",
          snapshot: original,
          preparedAt: "2026-08-30T09:00:00.000Z",
          progress: { artifacts: [] },
        },
        "undoing-key": {
          state: "undoing",
          transactionId: "transaction-2",
          idempotencyKey: "undoing-key",
          fingerprint: "sha256:undoing",
          snapshot: original,
          preparedAt: "2026-08-30T09:00:00.000Z",
          progress: { artifacts: [] },
          receipt,
          undoSnapshot: committed,
          undoRequestedAt: "2026-08-30T09:05:00.000Z",
        },
      },
    };
    writeFileSync(journalPath, JSON.stringify(journal));
    const liveState = clone(committed);
    const handlers = callbacks(liveState);
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });

    await expect(service.recover(handlers)).resolves.toEqual({ rolledBack: 1, undone: 1 });
    expect(handlers.rollback).toHaveBeenCalledWith({ snapshot: original, progress: { artifacts: [] } });
    expect(handlers.restore).toHaveBeenCalledWith({ snapshot: committed, receipt });
    expect(handlers.undo).not.toHaveBeenCalled();
    expect(service.inspect("prepared-key")).toMatchObject({ state: "rolled_back" });
    expect(service.inspect("undoing-key")).toMatchObject({ state: "committed" });
  });

  it("recovers every durably planned artifact without a global snapshot", async () => {
    const { journalPath } = setup();
    const state: State = { crews: ["unrelated-crew"], archives: ["unrelated-archive"] };
    const liveArtifacts = new Set(["bot-planned", "group-planned", "routine-planned", "unrelated-bot"]);
    const archivedFlags = new Map([["archived-crew", "hidden"], ["unrelated-archive", "visible"]]);
    const journal: CrewImportJournalFile<State, Result, Archived[]> = {
      version: 1,
      transactions: {
        "crash-key": {
          state: "prepared",
          transactionId: "crash-transaction",
          idempotencyKey: "crash-key",
          fingerprint: "sha256:crash",
          snapshot: { crews: [], archives: [] },
          preparedAt: "2026-08-30T09:00:00.000Z",
          progress: {
            artifacts: [
              { kind: "bot", id: "bot-planned" },
              { kind: "group", id: "group-planned" },
              { kind: "routine", id: "routine-planned" },
            ],
            archivedPriorStates: [{ crewId: "archived-crew", previousStatus: "active" }],
          },
        },
      },
    };
    writeFileSync(journalPath, JSON.stringify(journal));
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    const handlers: CrewImportCallbacks<State, Result, Archived[]> = {
      snapshot: async () => clone(state),
      restore: async () => {},
      rollback: vi.fn(async ({ progress }) => {
        for (const artifact of progress.artifacts) liveArtifacts.delete(artifact.id);
        for (const archived of progress.archivedPriorStates ?? []) {
          archivedFlags.set(archived.crewId, archived.previousStatus);
        }
      }),
      mutate: async () => { throw new Error("not used by recovery"); },
      undo: async () => {},
    };

    await expect(service.recover(handlers)).resolves.toEqual({ rolledBack: 1, undone: 0 });
    expect(handlers.rollback).toHaveBeenCalledWith({
      snapshot: { crews: [], archives: [] },
      progress: journal.transactions["crash-key"]!.progress,
    });
    expect(liveArtifacts).toEqual(new Set(["unrelated-bot"]));
    expect(archivedFlags).toEqual(new Map([["archived-crew", "active"], ["unrelated-archive", "visible"]]));
  });

  it("still compensates a failed import when undo recovery commits forward", async () => {
    const { journalPath } = setup();
    const state: State = { crews: ["crew-old"], archives: [] };
    const handlers = { ...callbacks(state), undoRecovery: "commit_forward" as const };
    await expect(new CrewImportTransactions<State, Result, Archived[]>({ journalPath }).execute(
      request(),
      {
        ...handlers,
        mutate: async (progress) => {
          await progress.artifactCreated({ kind: "bot", id: "crew-new" });
          state.crews.push("crew-new");
          throw new Error("planned import failed");
        },
      },
    )).rejects.toThrow("planned import failed");
    expect(handlers.rollback).toHaveBeenCalledWith(expect.objectContaining({
      progress: { artifacts: [{ kind: "bot", id: "crew-new" }] },
    }));
  });

  it("reports a durable pending outcome when commit-forward undo needs reconciliation", async () => {
    const { journalPath } = setup();
    const state: State = { crews: ["crew-old"], archives: [] };
    const handlers = {
      ...callbacks(state),
      undoRecovery: "commit_forward" as const,
      undo: vi.fn(async () => { throw new Error("disk interruption during artifact cleanup"); }),
    };
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    const receipt = await service.execute(request(), handlers);

    await expect(service.undo(request(), handlers)).rejects.toMatchObject({
      code: "UNDO_PENDING",
      status: 202,
    });
    expect(service.pendingUndoReceipts()).toEqual([receipt]);
    expect(service.inspect(request().idempotencyKey)).toMatchObject({ state: "undoing" });
  });

  it.each([
    ["unparseable JSON", "{not valid json"],
    ["valid JSON in the wrong shape", '{"version":1,"transactions":[]}'],
  ])("preserves a corrupt journal (%s) without throwing it out of the constructor", (_label, contents) => {
    // The original contract was "never silently discard recovery state", and it
    // was enforced by throwing. But this constructor runs at BOOT, so the throw
    // killed the process before it bound a port — on every restart, from a
    // bookkeeping file the app wrote itself. The workspace became permanently
    // unopenable with no operator-facing message.
    //
    // Quarantine keeps the original guarantee and drops the crash: the bytes are
    // moved aside intact and logged, and the service continues from empty. The
    // journal tracks in-flight imports only, so what is lost is an interrupted
    // import's undo history, never a committed operator or crew.
    const { journalPath } = setup();
    writeFileSync(journalPath, contents, "utf8");

    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    expect(service.inspect(request().idempotencyKey)).toBeUndefined();

    const quarantined = readdirSync(dirname(journalPath)).filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dirname(journalPath), quarantined[0]!), "utf8")).toBe(contents);

    // Restarting after recovery is clean: no second quarantine, no throw.
    const restarted = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    expect(restarted.inspect(request().idempotencyKey)).toBeUndefined();
    expect(readdirSync(dirname(journalPath)).filter((f) => f.includes(".corrupt-"))).toHaveLength(1);
  });

  it("rejects reserved and control-character idempotency keys", async () => {
    const { journalPath } = setup();
    const state: State = { crews: [], archives: [] };
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });

    expect(() => service.execute({ idempotencyKey: "__proto__", fingerprint: "sha256:one" }, callbacks(state))).toThrowError(
      expect.objectContaining({
        code: "INVALID_IDEMPOTENCY_KEY",
        status: 400,
      }),
    );
    expect(() => service.execute({ idempotencyKey: "bad\u0007key", fingerprint: "sha256:one" }, callbacks(state))).toThrowError(
      expect.objectContaining({
        code: "INVALID_IDEMPOTENCY_KEY",
        status: 400,
      }),
    );
  });

  it("allows visible Unicode keys but retires a key after undo", async () => {
    const { journalPath } = setup();
    const state: State = { crews: ["crew-old"], archives: [] };
    const service = new CrewImportTransactions<State, Result, Archived[]>({ journalPath });
    const unicodeRequest = { idempotencyKey: "crew-हेल्म-01", fingerprint: "sha256:unicode" };

    const receipt = await service.execute(unicodeRequest, callbacks(state));
    expect(receipt.idempotencyKey).toBe("crew-हेल्म-01");

    await expect(service.undo(unicodeRequest, callbacks(state))).resolves.toMatchObject({
      receipt: { transactionId: receipt.transactionId },
    });
    await expect(service.execute(unicodeRequest, callbacks(state))).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_RETIRED",
      status: 409,
    });
  });
});
