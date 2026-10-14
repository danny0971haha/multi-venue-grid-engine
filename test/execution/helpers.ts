import type { ClientOrderId } from "../../src/domain/ids.js";
import { makeClientOrderId, makeIntentId, makeScopeKey } from "../../src/domain/ids.js";
import type { OrderIntent } from "../../src/domain/types.js";
import {
  type ExecutionCheckpointStore,
  ExecutionCoordinator,
  type ExecutionCursor,
  type ExecutionVenuePort,
  type ExposureInputSource,
  type FenceResult,
  type IntentJournal,
  IntentRegistry,
  type IntentRegistryState,
  type MutationFence,
} from "../../src/execution/index.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";

export const SCOPE_KEY = makeScopeKey("canary-01", "sim", "BTC_USDC_PERP", "grid-v0.1");
export const OBSERVED_AT = "2026-08-22T00:00:00.000Z";

type IntentOverrides = Partial<
  Pick<
    OrderIntent,
    | "runId"
    | "anchorEpoch"
    | "logicalLevelId"
    | "purpose"
    | "side"
    | "type"
    | "timeInForce"
    | "price"
    | "quantity"
    | "reduceOnly"
    | "leaseGeneration"
  >
> & { sequence?: string };

// Builds a valid place intent whose intent ID and client order ID follow the domain derivation.
export function buildIntent(overrides: IntentOverrides = {}): OrderIntent {
  const { sequence = "1", ...fields } = overrides;
  const base = {
    experimentId: "exp-1",
    runId: "run-1",
    scopeKey: SCOPE_KEY,
    anchorEpoch: "epoch-1",
    logicalLevelId: "B1",
    purpose: "GRID_ENTRY",
    side: "BUY",
    type: "LIMIT",
    timeInForce: "GTC",
    price: "100",
    quantity: "0.01",
    reduceOnly: false,
    leaseGeneration: "1",
    createdAt: OBSERVED_AT,
    ...fields,
  } satisfies Omit<OrderIntent, "intentId" | "clientOrderId">;
  const intentId = makeIntentId({ ...base, sequence });
  return {
    ...base,
    intentId,
    clientOrderId: makeClientOrderId({ ...base, intentId }),
  };
}

export function clientIdOf(intent: OrderIntent): ClientOrderId {
  if (intent.clientOrderId === null) {
    throw new Error("TEST_INTENT_WITHOUT_CLIENT_ORDER_ID");
  }
  return intent.clientOrderId;
}

// In-memory journal that round-trips through JSON, like a durable store would.
export class MemoryJournal implements IntentJournal {
  readonly snapshots: string[] = [];
  private readonly script: Array<"OK" | "FAIL"> = [];

  scriptPersist(...outcomes: Array<"OK" | "FAIL">): void {
    this.script.push(...outcomes);
  }

  async persist(state: IntentRegistryState): Promise<void> {
    if ((this.script.shift() ?? "OK") === "FAIL") {
      throw new Error("TEST_JOURNAL_WRITE_FAILED");
    }
    this.snapshots.push(JSON.stringify(state));
  }

  latest(): unknown {
    const last = this.snapshots.at(-1);
    if (last === undefined) {
      throw new Error("TEST_JOURNAL_EMPTY");
    }
    return JSON.parse(last);
  }
}

// In-memory replay checkpoint store that round-trips through JSON.
export class MemoryCheckpointStore implements ExecutionCheckpointStore {
  readonly snapshots: string[] = [];
  private readonly script: Array<"OK" | "FAIL"> = [];

  scriptPersist(...outcomes: Array<"OK" | "FAIL">): void {
    this.script.push(...outcomes);
  }

  async persist(cursor: ExecutionCursor): Promise<void> {
    if ((this.script.shift() ?? "OK") === "FAIL") {
      throw new Error("TEST_CHECKPOINT_WRITE_FAILED");
    }
    this.snapshots.push(JSON.stringify(cursor));
  }

  latest(): ExecutionCursor | null {
    const last = this.snapshots.at(-1);
    return last === undefined ? null : (JSON.parse(last) as ExecutionCursor);
  }
}

// Always lets the mutation run; a throwing mutation is UNKNOWN, as with the lease fence.
export function openFence(leaseGeneration = "1"): MutationFence {
  return {
    leaseGeneration,
    async run<T>(mutation: () => Promise<T>): Promise<FenceResult<T>> {
      try {
        return { outcome: "SENT", value: await mutation(), reasonCodes: [] };
      } catch {
        return { outcome: "UNKNOWN", value: null, reasonCodes: ["FENCED_CALLBACK_THREW"] };
      }
    },
  };
}

export function notSentFence(leaseGeneration = "1"): MutationFence {
  return {
    leaseGeneration,
    async run<T>(): Promise<FenceResult<T>> {
      return { outcome: "NOT_SENT", value: null, reasonCodes: ["MUTATION_NOT_SENT"] };
    },
  };
}

// Flat position at mark 100, so only working orders and proposals count toward exposure.
export function flatExposure(): ExposureInputSource {
  return { read: async () => ({ signedPosition: "0", markOrMidPrice: "100" }) };
}

export type Harness = {
  venue: SimulatedVenue;
  journal: MemoryJournal;
  registry: IntentRegistry;
  checkpoints: MemoryCheckpointStore;
  coordinator: ExecutionCoordinator;
};

// Starts a coordinator from the given (or the latest checkpointed) cursor and, unless replay
// is false, runs its first execution replay, as a runtime must before any risk increase.
export async function createHarness(
  options: {
    venue?: SimulatedVenue;
    port?: ExecutionVenuePort;
    journal?: MemoryJournal;
    registry?: IntentRegistry;
    checkpoints?: MemoryCheckpointStore;
    executionCursor?: ExecutionCursor | null;
    fence?: MutationFence;
    exposure?: ExposureInputSource;
    writeBudgetPerCycle?: number;
    replay?: boolean;
  } = {},
): Promise<Harness> {
  const venue = options.venue ?? new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
  const journal = options.journal ?? new MemoryJournal();
  const registry = options.registry ?? new IntentRegistry();
  const checkpoints = options.checkpoints ?? new MemoryCheckpointStore();
  const coordinator = new ExecutionCoordinator({
    config: {
      experimentId: "exp-1",
      runId: "run-1",
      scopeKey: SCOPE_KEY,
      writeBudgetPerCycle: options.writeBudgetPerCycle ?? 100,
    },
    registry,
    venue: options.port ?? venue,
    fence: options.fence ?? openFence(),
    journal,
    exposure: options.exposure ?? flatExposure(),
    checkpoints,
    executionCursor:
      options.executionCursor === undefined ? checkpoints.latest() : options.executionCursor,
  });
  if (options.replay ?? true) {
    await coordinator.replayExecutions();
  }
  return { venue, journal, registry, checkpoints, coordinator };
}
