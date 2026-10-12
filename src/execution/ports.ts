import type { ClientOrderId } from "../domain/ids.js";
import type {
  ExchangeOrderObservation,
  ExecutionObservation,
  OrderAck,
  OrderIntent,
  VenueWriteResult,
} from "../domain/types.js";
import type { IntentRegistryState } from "./intent-registry.js";

// Read result for one deterministic client order ID. A rejected promise means the read
// failed and proves nothing; both fields empty means nothing definitive was found.
export type ClientOrderLookup = {
  order: ExchangeOrderObservation | null;
  executions: ExecutionObservation[];
};

// The venue surface the coordinator needs. Venue adapters and the simulated venue implement
// it; neither owns intent state.
export type ExecutionVenuePort = {
  placeOrder(intent: OrderIntent): Promise<VenueWriteResult<OrderAck>>;
  lookupClientOrder(clientOrderId: ClientOrderId): Promise<ClientOrderLookup>;
};

export type FenceOutcome = "SENT" | "NOT_SENT" | "UNKNOWN";

export type FenceResult<T> = {
  outcome: FenceOutcome;
  value: T | null;
  reasonCodes: string[];
};

// Runs one venue mutation only after proving the runtime lease immediately beforehand.
// NOT_SENT means the mutation callback was never invoked; a throwing callback is UNKNOWN.
export type MutationFence = {
  readonly leaseGeneration: string;
  run<T>(mutation: () => Promise<T>): Promise<FenceResult<T>>;
};

// Durable write-ahead store for the intent registry. A rejection means durability is not
// proven and the coordinator latches closed.
export type IntentJournal = {
  persist(state: IntentRegistryState): Promise<void>;
};
