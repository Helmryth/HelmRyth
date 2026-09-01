import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { loadOrQuarantine, writeFileAtomic } from "./atomic.ts";
import { ensurePrivateDirectory, repairPrivateFile } from "./private-storage.ts";

export type CrewImportRequest = {
  idempotencyKey: string;
  fingerprint: string;
};

export type CrewImportMutation<Result, ArchivedPriorStates> = {
  result: Result;
  artifactIds: string[];
  archivedPriorStates: ArchivedPriorStates;
};

export type CrewImportArtifact = {
  kind: "bot" | "group" | "routine";
  id: string;
};

export type CrewImportProgress<ArchivedPriorStates = unknown> = {
  artifacts: CrewImportArtifact[];
  archivedPriorStates?: ArchivedPriorStates;
};

export type CrewImportProgressRecorder<ArchivedPriorStates> = {
  artifactCreated: (artifact: CrewImportArtifact) => Promise<void>;
  archivedPriorStates: (states: ArchivedPriorStates) => Promise<void>;
};

export type CrewImportReceipt<Result = unknown, ArchivedPriorStates = unknown> = {
  transactionId: string;
  idempotencyKey: string;
  fingerprint: string;
  result: Result;
  artifactIds: string[];
  archivedPriorStates: ArchivedPriorStates;
  committedAt: string;
};

export type CrewImportUndoReceipt<Result = unknown, ArchivedPriorStates = unknown> = {
  receipt: CrewImportReceipt<Result, ArchivedPriorStates>;
  undoneAt: string;
};

export type CrewImportCallbacks<Snapshot, Result, ArchivedPriorStates> = {
  /** Capture the state needed to compensate a failed undo. */
  snapshot: () => Promise<Snapshot>;
  /** Re-apply the pre-undo state, scoped to this receipt's artifacts. */
  restore: (input: {
    snapshot: Snapshot;
    receipt: CrewImportReceipt<Result, ArchivedPriorStates>;
  }) => Promise<void>;
  /** Compensate a failed import without replacing unrelated live state. */
  rollback: (input: {
    snapshot: Snapshot;
    receipt?: CrewImportReceipt<Result, ArchivedPriorStates>;
    progress: CrewImportProgress<ArchivedPriorStates>;
  }) => Promise<void>;
  /**
   * Only use `restore` when the snapshot is genuinely sufficient to recover
   * every artifact the undo may have changed. Otherwise an idempotent undo
   * commits forward on restart.
   */
  undoRecovery?: "restore_snapshot" | "commit_forward";
  /** Perform the import and report every durable artifact/archive identity it produced. */
  mutate: (progress: CrewImportProgressRecorder<ArchivedPriorStates>) => Promise<CrewImportMutation<Result, ArchivedPriorStates>>;
  /** Reverse a committed import. This callback must be idempotent for restart recovery. */
  undo: (input: {
    receipt: CrewImportReceipt<Result, ArchivedPriorStates>;
    snapshot: Snapshot;
  }) => Promise<void>;
};

type PreparedTransaction<Snapshot, ArchivedPriorStates = unknown> = {
  state: "prepared";
  transactionId: string;
  idempotencyKey: string;
  fingerprint: string;
  snapshot: Snapshot;
  preparedAt: string;
  progress: CrewImportProgress<ArchivedPriorStates>;
};

type CommittedTransaction<Snapshot, Result, ArchivedPriorStates> = Omit<
  PreparedTransaction<Snapshot, ArchivedPriorStates>,
  "state"
> & {
  state: "committed";
  receipt: CrewImportReceipt<Result, ArchivedPriorStates>;
};

type UndoingTransaction<Snapshot, Result, ArchivedPriorStates> = Omit<
  CommittedTransaction<Snapshot, Result, ArchivedPriorStates>,
  "state"
> & {
  state: "undoing";
  undoSnapshot: Snapshot;
  undoRequestedAt: string;
};

/**
 * Undo changed live state but its final committed receipt could not be
 * persisted. The pre-undo snapshot remains authoritative on restart.
 */
type UndoCompensationPendingTransaction<Snapshot, Result, ArchivedPriorStates> = Omit<
  UndoingTransaction<Snapshot, Result, ArchivedPriorStates>,
  "state"
> & {
  state: "undo_compensation_pending";
  undoFailure: string;
  compensationPreparedAt: string;
};

type UndoneTransaction<Snapshot, Result, ArchivedPriorStates> = Omit<
  UndoingTransaction<Snapshot, Result, ArchivedPriorStates>,
  "state" | "undoSnapshot"
> & {
  state: "undone";
  undoReceipt: CrewImportUndoReceipt<Result, ArchivedPriorStates>;
};

type RolledBackTransaction<Snapshot, ArchivedPriorStates = unknown> = Omit<PreparedTransaction<Snapshot, ArchivedPriorStates>, "state"> & {
  state: "rolled_back";
  rolledBackAt: string;
  failure: string;
};

type RollbackFailedTransaction<Snapshot, ArchivedPriorStates = unknown> = Omit<PreparedTransaction<Snapshot, ArchivedPriorStates>, "state"> & {
  state: "rollback_failed";
  rollbackAttemptedAt: string;
  failure: string;
  rollbackFailure: string;
};

export type CrewImportTransaction<Snapshot = unknown, Result = unknown, ArchivedPriorStates = unknown> =
  | PreparedTransaction<Snapshot, ArchivedPriorStates>
  | CommittedTransaction<Snapshot, Result, ArchivedPriorStates>
  | UndoingTransaction<Snapshot, Result, ArchivedPriorStates>
  | UndoCompensationPendingTransaction<Snapshot, Result, ArchivedPriorStates>
  | UndoneTransaction<Snapshot, Result, ArchivedPriorStates>
  | RolledBackTransaction<Snapshot, ArchivedPriorStates>
  | RollbackFailedTransaction<Snapshot, ArchivedPriorStates>;

export type CrewImportJournalFile<
  Snapshot = unknown,
  Result = unknown,
  ArchivedPriorStates = unknown,
> = {
  version: 1;
  transactions: Record<string, CrewImportTransaction<Snapshot, Result, ArchivedPriorStates>>;
};

export type CrewImportFaultPoint =
  | "after_prepare_persist"
  | "after_mutation"
  | "before_commit_persist"
  | "after_undo_prepare_persist"
  | "after_undo"
  | "before_undo_commit_persist"
  | "before_undo_rollback_commit_persist";

export type CrewImportFaultContext = {
  point: CrewImportFaultPoint;
  idempotencyKey: string;
  transactionId: string;
};

export type CrewImportTransactionsOptions<Snapshot = unknown, Result = unknown, ArchivedPriorStates = unknown> = {
  journalPath: string;
  now?: () => string;
  idFactory?: () => string;
  /** Test/chaos hook. Throwing exercises rollback without weakening production writes. */
  fault?: (context: CrewImportFaultContext) => void | Promise<void>;
  /** Upgrade an older private journal before it can be served or replayed. */
  migrate?: (
    journal: CrewImportJournalFile<Snapshot, Result, ArchivedPriorStates>,
  ) => CrewImportJournalFile<Snapshot, Result, ArchivedPriorStates>;
};

export class CrewImportTransactionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "CrewImportTransactionError";
    this.code = code;
    this.status = status;
  }
}

const RESERVED_IDEMPOTENCY_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function transactionRecord<Value>(
  entries: Iterable<readonly [string, Value]> = [],
): Record<string, Value> {
  // SAFETY: the caller supplies plain string keys, and a null-prototype object
  // prevents reserved property names from changing lookup semantics.
  const record = Object.create(null) as Record<string, Value>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

function errorMessage<Failure>(error: Failure): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRequest(request: CrewImportRequest): void {
  if (!request.idempotencyKey.trim() || request.idempotencyKey.length > 200) {
    throw new CrewImportTransactionError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotencyKey must contain between 1 and 200 characters",
      400,
    );
  }
  if (hasControlCharacters(request.idempotencyKey) || RESERVED_IDEMPOTENCY_KEYS.has(request.idempotencyKey)) {
    throw new CrewImportTransactionError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotencyKey must not contain control characters or reserved object-property names",
      400,
    );
  }
  if (!request.fingerprint.trim() || request.fingerprint.length > 500) {
    throw new CrewImportTransactionError(
      "INVALID_FINGERPRINT",
      "fingerprint must contain between 1 and 500 characters",
      400,
    );
  }
}

function assertSerializable<Value>(value: Value, label: string): void {
  try {
    if (JSON.stringify(value) === undefined) throw new Error("value is not representable in JSON");
  } catch (error) {
    throw new CrewImportTransactionError(
      "NON_SERIALIZABLE_STATE",
      `${label} must be JSON-serializable`,
      500,
      { cause: error },
    );
  }
}

const receiptSchema = z.object({
  transactionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().min(1),
  result: z.json(),
  artifactIds: z.array(z.string().min(1)),
  archivedPriorStates: z.json(),
  committedAt: z.string().min(1),
});

const preparedFields = {
  transactionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().min(1),
  snapshot: z.json(),
  preparedAt: z.string().min(1),
  // Older private journals did not have scoped progress. They remain readable
  // and are upgraded on the next atomic write; an empty progress set is safe.
  progress: z.object({
    artifacts: z.array(z.object({ kind: z.enum(["bot", "group", "routine"]), id: z.string().min(1) })),
    archivedPriorStates: z.json().optional(),
  }).optional(),
};

const undoReceiptSchema = z.object({ receipt: receiptSchema, undoneAt: z.string().min(1) });

const transactionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("prepared"), ...preparedFields }),
  z.object({ state: z.literal("committed"), ...preparedFields, receipt: receiptSchema }),
  z.object({
    state: z.literal("undoing"),
    ...preparedFields,
    receipt: receiptSchema,
    undoSnapshot: z.json(),
    undoRequestedAt: z.string().min(1),
  }),
  z.object({
    state: z.literal("undo_compensation_pending"),
    ...preparedFields,
    receipt: receiptSchema,
    undoSnapshot: z.json(),
    undoRequestedAt: z.string().min(1),
    undoFailure: z.string(),
    compensationPreparedAt: z.string().min(1),
  }),
  z.object({
    state: z.literal("undone"),
    ...preparedFields,
    receipt: receiptSchema,
    undoRequestedAt: z.string().min(1),
    undoReceipt: undoReceiptSchema,
  }),
  z.object({
    state: z.literal("rolled_back"),
    ...preparedFields,
    rolledBackAt: z.string().min(1),
    failure: z.string(),
  }),
  z.object({
    state: z.literal("rollback_failed"),
    ...preparedFields,
    rollbackAttemptedAt: z.string().min(1),
    failure: z.string(),
    rollbackFailure: z.string(),
  }),
]);

const journalSchema = z
  .object({ version: z.literal(1), transactions: z.record(z.string(), transactionSchema) })
  .superRefine((journal, context) => {
    for (const [key, transaction] of Object.entries(journal.transactions)) {
      if (transaction.idempotencyKey !== key) {
        context.addIssue({
          code: "custom",
          path: ["transactions", key, "idempotencyKey"],
          message: "transaction key does not match idempotencyKey",
        });
      }
    }
  });

function readJournal<Snapshot, Result, ArchivedPriorStates>(
  journalPath: string,
): CrewImportJournalFile<Snapshot, Result, ArchivedPriorStates> {
  if (!existsSync(journalPath)) return { version: 1, transactions: transactionRecord() };
  repairPrivateFile(journalPath);
  let parsed: z.input<typeof journalSchema>;
  try {
    parsed = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw new CrewImportTransactionError(
      "CORRUPT_JOURNAL",
      "Crew import transaction journal is not valid JSON",
      500,
      { cause: error },
    );
  }
  const validated = journalSchema.safeParse(parsed);
  if (!validated.success) {
    throw new CrewImportTransactionError(
      "CORRUPT_JOURNAL",
      `Crew import transaction journal failed validation: ${z.prettifyError(validated.error)}`,
      500,
    );
  }
  // SAFETY: journalSchema validated every state variant and all persisted values as JSON;
  // callers supply the matching generic types for their dedicated journal path.
  const entries: Array<readonly [string, CrewImportTransaction<Snapshot, Result, ArchivedPriorStates>]> = [];
  for (const [key, value] of Object.entries(validated.data.transactions)) {
    // SAFETY: journalSchema validated each persisted transaction variant and
    // its JSON payload. This narrows the validated record to the caller's
    // matching generic instantiation for this journal path.
    const normalized = value.progress === undefined
      ? { ...value, progress: { artifacts: [] } }
      : value;
    // SAFETY: validation proved every original field; the compatibility
    // default supplies the only newly-required field for older journals.
    entries.push([key, normalized as CrewImportTransaction<Snapshot, Result, ArchivedPriorStates>]);
  }
  return { version: 1, transactions: transactionRecord(entries) };
}

/**
 * A single-process serialization and durability boundary for crew imports.
 *
 * Every external mutation is preceded by an atomic prepared/undoing record.
 * Call `recover()` once during startup before accepting import traffic. A
 * multi-process deployment must additionally ensure that only one process owns
 * a given journal file.
 */
export class CrewImportTransactions<Snapshot, Result, ArchivedPriorStates> {
  private readonly journalPath: string;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly fault?: (context: CrewImportFaultContext) => void | Promise<void>;
  private journal: CrewImportJournalFile<Snapshot, Result, ArchivedPriorStates>;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: CrewImportTransactionsOptions<Snapshot, Result, ArchivedPriorStates>) {
    if (!options.journalPath) {
      throw new CrewImportTransactionError(
        "INVALID_JOURNAL_PATH",
        "journalPath is required",
        500,
      );
    }
    this.journalPath = options.journalPath;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.fault = options.fault;
    // A corrupt journal used to escape this constructor, and the constructor
    // runs at boot — so the process died before binding a port, on EVERY
    // restart, from a bookkeeping file the app wrote itself. The workspace
    // became permanently unopenable with no operator-facing message. Preserve
    // the bytes and continue from empty; the journal records in-flight imports
    // only, so losing it costs an interrupted import's undo history, never a
    // committed operator or crew.
    const loaded = loadOrQuarantine(this.journalPath, () =>
      readJournal<Snapshot, Result, ArchivedPriorStates>(this.journalPath));
    const migrated = options.migrate?.(structuredClone(loaded)) ?? loaded;
    assertSerializable(migrated, "migrated journal");
    this.journal = migrated;
    if (JSON.stringify(loaded) !== JSON.stringify(migrated)) {
      ensurePrivateDirectory(dirname(this.journalPath));
      writeFileAtomic(this.journalPath, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
    }
  }

  inspect(
    idempotencyKey: string,
  ): CrewImportTransaction<Snapshot, Result, ArchivedPriorStates> | undefined {
    const transaction = this.journal.transactions[idempotencyKey];
    return transaction === undefined ? undefined : structuredClone(transaction);
  }

  committedReceipts(): CrewImportReceipt<Result, ArchivedPriorStates>[] {
    return Object.values(this.journal.transactions)
      .flatMap((transaction) => transaction.state === "committed" ? [transaction.receipt] : [])
      .sort((left, right) => right.committedAt.localeCompare(left.committedAt))
      .map((receipt) => structuredClone(receipt));
  }

  pendingUndoReceipts(): CrewImportReceipt<Result, ArchivedPriorStates>[] {
    return Object.values(this.journal.transactions)
      .flatMap((transaction) => transaction.state === "undoing" ? [transaction.receipt] : [])
      .sort((left, right) => right.committedAt.localeCompare(left.committedAt))
      .map((receipt) => structuredClone(receipt));
  }

  requestForTransaction(transactionId: string): CrewImportRequest | null {
    const transaction = Object.values(this.journal.transactions).find(
      (candidate) => candidate.transactionId === transactionId,
    );
    return transaction
      ? { idempotencyKey: transaction.idempotencyKey, fingerprint: transaction.fingerprint }
      : null;
  }

  execute(
    request: CrewImportRequest,
    callbacks: CrewImportCallbacks<Snapshot, Result, ArchivedPriorStates>,
  ): Promise<CrewImportReceipt<Result, ArchivedPriorStates>> {
    assertRequest(request);
    return this.serialize(async () => {
      const existing = this.journal.transactions[request.idempotencyKey];
      this.assertFingerprint(existing, request);
      if (existing?.state === "committed") {
        return structuredClone(existing.receipt);
      }
      if (existing?.state === "undone") {
        throw new CrewImportTransactionError(
          "IDEMPOTENCY_KEY_RETIRED",
          "This crew import was already undone. Start a new import with a fresh Idempotency-Key header.",
          409,
        );
      }
      if (existing?.state === "prepared" || existing?.state === "undoing") {
        throw new CrewImportTransactionError(
          "RECOVERY_REQUIRED",
          "The transaction has an interrupted operation; run recovery before retrying",
          409,
        );
      }
      if (existing?.state === "rollback_failed") {
        throw new CrewImportTransactionError(
          "RECOVERY_REQUIRED",
          "The transaction has an incomplete rollback; run recovery before retrying",
          409,
        );
      }

      const snapshot = await callbacks.snapshot();
      assertSerializable(snapshot, "snapshot");
      const prepared: PreparedTransaction<Snapshot, ArchivedPriorStates> = {
        state: "prepared",
        transactionId: this.idFactory(),
        idempotencyKey: request.idempotencyKey,
        fingerprint: request.fingerprint,
        snapshot,
        preparedAt: this.now(),
        progress: { artifacts: [] },
      };
      await this.put(prepared);

      let receipt: CrewImportReceipt<Result, ArchivedPriorStates> | undefined;
      try {
        await this.inject("after_prepare_persist", prepared);
        const mutation = await callbacks.mutate(this.progressRecorder(prepared));
        assertSerializable(mutation, "mutation result");
        if (!Array.isArray(mutation.artifactIds) || mutation.artifactIds.some((id) => !id)) {
          throw new CrewImportTransactionError(
            "INVALID_MUTATION_RESULT",
            "artifactIds must contain non-empty identifiers",
            500,
          );
        }
        const recordedPrepared = this.preparedWithProgress(prepared);
        receipt = {
          transactionId: recordedPrepared.transactionId,
          idempotencyKey: recordedPrepared.idempotencyKey,
          fingerprint: recordedPrepared.fingerprint,
          result: mutation.result,
          artifactIds: [...mutation.artifactIds],
          archivedPriorStates: mutation.archivedPriorStates,
          committedAt: this.now(),
        };
        await this.inject("after_mutation", prepared);
        const committed: CommittedTransaction<Snapshot, Result, ArchivedPriorStates> = {
          ...recordedPrepared,
          state: "committed",
          receipt,
        };
        await this.inject("before_commit_persist", prepared);
        await this.put(committed);
        return structuredClone(receipt);
      } catch (error) {
        await this.rollbackImport(prepared, callbacks, error, receipt);
        throw error;
      }
    });
  }

  undo(
    request: CrewImportRequest,
    callbacks: CrewImportCallbacks<Snapshot, Result, ArchivedPriorStates>,
  ): Promise<CrewImportUndoReceipt<Result, ArchivedPriorStates>> {
    assertRequest(request);
    return this.serialize(async () => {
      const existing = this.journal.transactions[request.idempotencyKey];
      if (!existing) {
        throw new CrewImportTransactionError(
          "TRANSACTION_NOT_FOUND",
          "No committed import exists for this idempotency key",
          404,
        );
      }
      this.assertFingerprint(existing, request);
      if (existing.state === "undone") return structuredClone(existing.undoReceipt);
      if (existing.state !== "committed") {
        throw new CrewImportTransactionError(
          "IMPORT_NOT_COMMITTED",
          "Only a committed import can be undone",
          409,
        );
      }

      const undoSnapshot = await callbacks.snapshot();
      assertSerializable(undoSnapshot, "undo snapshot");
      const undoing: UndoingTransaction<Snapshot, Result, ArchivedPriorStates> = {
        ...existing,
        state: "undoing",
        undoSnapshot,
        undoRequestedAt: this.now(),
      };
      await this.put(undoing);
      try {
        await this.inject("after_undo_prepare_persist", undoing);
        await callbacks.undo({ receipt: existing.receipt, snapshot: existing.snapshot });
        await this.inject("after_undo", undoing);
        const undoReceipt: CrewImportUndoReceipt<Result, ArchivedPriorStates> = {
          receipt: existing.receipt,
          undoneAt: this.now(),
        };
        const undone: UndoneTransaction<Snapshot, Result, ArchivedPriorStates> = {
          state: "undone",
          transactionId: undoing.transactionId,
          idempotencyKey: undoing.idempotencyKey,
          fingerprint: undoing.fingerprint,
          snapshot: undoing.snapshot,
          preparedAt: undoing.preparedAt,
          progress: undoing.progress,
          receipt: undoing.receipt,
          undoRequestedAt: undoing.undoRequestedAt,
          undoReceipt,
        };
        await this.inject("before_undo_commit_persist", undoing);
        await this.put(undone);
        return structuredClone(undoReceipt);
      } catch (error) {
        await this.rollbackUndo(existing, undoing, callbacks, error);
        throw error;
      }
    });
  }

  recover(
    callbacks: CrewImportCallbacks<Snapshot, Result, ArchivedPriorStates>,
  ): Promise<{ rolledBack: number; undone: number }> {
    return this.serialize(async () => {
      let rolledBack = 0;
      let undone = 0;
      for (const key of Object.keys(this.journal.transactions).sort()) {
        const transaction = this.journal.transactions[key];
        if (transaction.state === "prepared" || transaction.state === "rollback_failed") {
          try {
            await callbacks.rollback({ snapshot: transaction.snapshot, progress: transaction.progress });
            const recovered: RolledBackTransaction<Snapshot, ArchivedPriorStates> = {
              state: "rolled_back",
              transactionId: transaction.transactionId,
              idempotencyKey: transaction.idempotencyKey,
              fingerprint: transaction.fingerprint,
              snapshot: transaction.snapshot,
              preparedAt: transaction.preparedAt,
              progress: transaction.progress,
              rolledBackAt: this.now(),
              failure: "Recovered an interrupted import",
            };
            await this.put(recovered);
            rolledBack += 1;
          } catch (error) {
            await this.recordRecoveryRollbackFailure(transaction, error);
            throw error;
          }
        } else if (transaction.state === "undoing" && callbacks.undoRecovery === "commit_forward") {
          // The callback owns an idempotent, artifact-scoped deletion. Its
          // snapshot intentionally omits private transcripts and workspace
          // payloads, so replaying the same deletion is safer than pretending
          // we can reconstruct a complete pre-undo world.
          await callbacks.undo({ receipt: transaction.receipt, snapshot: transaction.snapshot });
          const undoReceipt: CrewImportUndoReceipt<Result, ArchivedPriorStates> = {
            receipt: transaction.receipt,
            undoneAt: this.now(),
          };
          const recovered: UndoneTransaction<Snapshot, Result, ArchivedPriorStates> = {
            state: "undone",
            transactionId: transaction.transactionId,
            idempotencyKey: transaction.idempotencyKey,
            fingerprint: transaction.fingerprint,
            snapshot: transaction.snapshot,
            preparedAt: transaction.preparedAt,
            progress: transaction.progress,
            receipt: transaction.receipt,
            undoRequestedAt: transaction.undoRequestedAt,
            undoReceipt,
          };
          await this.put(recovered);
          undone += 1;
        } else if (transaction.state === "undoing" || transaction.state === "undo_compensation_pending") {
          // An undoing record does not prove whether undo completed before a
          // crash. Replaying it can delete a second, unrelated generation of
          // artifacts. The durable pre-undo snapshot is the safe authority:
          // restore it, retain the original committed receipt, and let the
          // user explicitly request undo again.
          await callbacks.restore({ snapshot: transaction.undoSnapshot, receipt: transaction.receipt });
          const recovered: CommittedTransaction<Snapshot, Result, ArchivedPriorStates> = {
            state: "committed",
            transactionId: transaction.transactionId,
            idempotencyKey: transaction.idempotencyKey,
            fingerprint: transaction.fingerprint,
            snapshot: transaction.snapshot,
            preparedAt: transaction.preparedAt,
            progress: transaction.progress,
            receipt: transaction.receipt,
          };
          await this.put(recovered);
          undone += 1;
        }
      }
      return { rolledBack, undone };
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertFingerprint(
    existing: CrewImportTransaction<Snapshot, Result, ArchivedPriorStates> | undefined,
    request: CrewImportRequest,
  ): void {
    if (existing && existing.fingerprint !== request.fingerprint) {
      throw new CrewImportTransactionError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key is already bound to a different import fingerprint",
        409,
      );
    }
  }

  private async inject(
    point: CrewImportFaultPoint,
    transaction: { idempotencyKey: string; transactionId: string },
  ): Promise<void> {
    await this.fault?.({
      point,
      idempotencyKey: transaction.idempotencyKey,
      transactionId: transaction.transactionId,
    });
  }

  private async put(
    transaction: CrewImportTransaction<Snapshot, Result, ArchivedPriorStates>,
  ): Promise<void> {
    // SAFETY: this.journal is populated only by readJournal/put, both of which
    // admit validated CrewImportTransaction values for this generic instantiation.
    const entries = Object.entries(this.journal.transactions) as Array<
      readonly [string, CrewImportTransaction<Snapshot, Result, ArchivedPriorStates>]
    >;
    entries.push([transaction.idempotencyKey, transaction]);
    const next: CrewImportJournalFile<Snapshot, Result, ArchivedPriorStates> = {
      version: 1,
      transactions: transactionRecord(entries),
    };
    assertSerializable(next, "journal");
    ensurePrivateDirectory(dirname(this.journalPath));
    writeFileAtomic(this.journalPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.journal = next;
  }

  private progressRecorder(
    prepared: PreparedTransaction<Snapshot, ArchivedPriorStates>,
  ): CrewImportProgressRecorder<ArchivedPriorStates> {
    const update = async (nextProgress: CrewImportProgress<ArchivedPriorStates>) => {
      assertSerializable(nextProgress, "import progress");
      const current = this.journal.transactions[prepared.idempotencyKey];
      if (!current || current.state !== "prepared") {
        throw new CrewImportTransactionError(
          "PROGRESS_OUT_OF_SEQUENCE",
          "Cannot record import progress outside an active prepared transaction",
          500,
        );
      }
      await this.put({ ...prepared, progress: nextProgress });
    };
    return {
      artifactCreated: async (artifact) => {
        if (!artifact.id) {
          throw new CrewImportTransactionError("INVALID_MUTATION_RESULT", "artifact id is required", 500);
        }
        if (artifact.kind !== "bot" && artifact.kind !== "group" && artifact.kind !== "routine") {
          throw new CrewImportTransactionError("INVALID_MUTATION_RESULT", "artifact kind is invalid", 500);
        }
        const current = this.journal.transactions[prepared.idempotencyKey];
        const progress = current?.state === "prepared" ? current.progress : prepared.progress;
        if (progress.artifacts.some((candidate) => candidate.kind === artifact.kind && candidate.id === artifact.id)) return;
        await update({ ...progress, artifacts: [...progress.artifacts, { ...artifact }] });
      },
      archivedPriorStates: async (states) => {
        const current = this.journal.transactions[prepared.idempotencyKey];
        const progress = current?.state === "prepared" ? current.progress : prepared.progress;
        await update({ ...progress, archivedPriorStates: structuredClone(states) });
      },
    };
  }

  private preparedWithProgress(
    prepared: PreparedTransaction<Snapshot, ArchivedPriorStates>,
  ): PreparedTransaction<Snapshot, ArchivedPriorStates> {
    const current = this.journal.transactions[prepared.idempotencyKey];
    return current?.state === "prepared" ? current : prepared;
  }

  private async rollbackImport<Failure>(
    prepared: PreparedTransaction<Snapshot, ArchivedPriorStates>,
    callbacks: CrewImportCallbacks<Snapshot, Result, ArchivedPriorStates>,
    failure: Failure,
    receipt?: CrewImportReceipt<Result, ArchivedPriorStates>,
  ): Promise<void> {
    const recordedPrepared = this.preparedWithProgress(prepared);
    try {
      await callbacks.rollback({ snapshot: recordedPrepared.snapshot, receipt, progress: recordedPrepared.progress });
    } catch (rollbackError) {
      const failed: RollbackFailedTransaction<Snapshot, ArchivedPriorStates> = {
        ...recordedPrepared,
        state: "rollback_failed",
        rollbackAttemptedAt: this.now(),
        failure: errorMessage(failure),
        rollbackFailure: errorMessage(rollbackError),
      };
      await this.put(failed);
      throw new AggregateError(
        [failure, rollbackError],
        "Crew import failed and its snapshot could not be restored",
      );
    }
    const rolledBack: RolledBackTransaction<Snapshot, ArchivedPriorStates> = {
      ...recordedPrepared,
      state: "rolled_back",
      rolledBackAt: this.now(),
      failure: errorMessage(failure),
    };
    await this.put(rolledBack);
  }

  private async rollbackUndo<Failure>(
    committed: CommittedTransaction<Snapshot, Result, ArchivedPriorStates>,
    undoing: UndoingTransaction<Snapshot, Result, ArchivedPriorStates>,
    callbacks: CrewImportCallbacks<Snapshot, Result, ArchivedPriorStates>,
    failure: Failure,
  ): Promise<void> {
    if (callbacks.undoRecovery === "commit_forward") {
      if (
        failure instanceof CrewImportTransactionError
        && (failure.code === "IMPORT_BUSY" || failure.code === "IMPORT_IN_USE")
      ) {
        // These guards run before the artifact-scoped undo touches storage,
        // so returning to committed is truthful and keeps the button usable.
        await this.put(committed);
        return;
      }
      // `undoing` is already durable. Leave it in place: restart replays the
      // idempotent, artifact-scoped undo to completion instead of fabricating
      // a snapshot restore we cannot prove is complete.
      throw new CrewImportTransactionError(
        "UNDO_PENDING",
        "Undo cleanup is durably pending reconciliation",
        202,
        { cause: failure },
      );
    }
    try {
      await callbacks.restore({ snapshot: undoing.undoSnapshot, receipt: committed.receipt });
      // Persist the compensation intent *before* attempting to restore the
      // committed record. If that final put fails, restart sees this durable
      // state and restores/keeps undoSnapshot rather than replaying undo.
      const pending: UndoCompensationPendingTransaction<Snapshot, Result, ArchivedPriorStates> = {
        state: "undo_compensation_pending",
        transactionId: undoing.transactionId,
        idempotencyKey: undoing.idempotencyKey,
        fingerprint: undoing.fingerprint,
        snapshot: undoing.snapshot,
        preparedAt: undoing.preparedAt,
        progress: undoing.progress,
        receipt: undoing.receipt,
        undoSnapshot: undoing.undoSnapshot,
        undoRequestedAt: undoing.undoRequestedAt,
        undoFailure: errorMessage(failure),
        compensationPreparedAt: this.now(),
      };
      await this.put(pending);
      await this.inject("before_undo_rollback_commit_persist", pending);
      await this.put(committed);
    } catch (rollbackError) {
      throw new AggregateError(
        [failure, rollbackError],
        "Crew import undo failed and the committed state could not be restored",
      );
    }
  }

  private async recordRecoveryRollbackFailure<Failure>(
    transaction: PreparedTransaction<Snapshot, ArchivedPriorStates> | RollbackFailedTransaction<Snapshot, ArchivedPriorStates>,
    failure: Failure,
  ): Promise<void> {
    const failed: RollbackFailedTransaction<Snapshot, ArchivedPriorStates> = {
      state: "rollback_failed",
      transactionId: transaction.transactionId,
      idempotencyKey: transaction.idempotencyKey,
      fingerprint: transaction.fingerprint,
      snapshot: transaction.snapshot,
      preparedAt: transaction.preparedAt,
      progress: transaction.progress,
      rollbackAttemptedAt: this.now(),
      failure: "Recovered an interrupted import",
      rollbackFailure: errorMessage(failure),
    };
    await this.put(failed);
  }
}
