import type { ClientOrderId, ExecutionId, MarketId, VenueId } from "../domain/ids.js";
import type { DecimalString } from "../math/decimal.js";
import type {
  CancelAck,
  CancelRequest,
  ExchangeOrderObservation,
  ExecutionObservation,
  OrderAck,
  OrderIntent,
  VenueWriteResult,
} from "../domain/types.js";
import type { RiskInput } from "../risk/risk-types.js";
import type { IntentRegistryState } from "./intent-registry.js";

// Fresh read result for one deterministic client order ID. A rejected promise means the read
// failed and proves nothing; both fields empty means nothing definitive was found. Order
// status must be normalized to OPEN, FILLED or CANCELLED; any other status proves nothing.
export type ClientOrderLookup = {
  order: ExchangeOrderObservation | null;
  executions: ExecutionObservation[];
};

// Durable position in the venue's execution history for one market. Only the adapter
// interprets opaque; the coordinator stores it and passes it back unchanged.
export type ExecutionCursor = {
  venue: VenueId;
  market: MarketId;
  opaque: string;
  lastExecutionId: ExecutionId | null;
  lastExecutionTime: string | null;
};

// One page of execution history from a cursor. Pages may overlap earlier pages; replay
// deduplicates by execution ID. hasMore false means the page reached the current end.
export type ExecutionPage = {
  executions: ExecutionObservation[];
  nextCursor: ExecutionCursor;
  hasMore: boolean;
};

// The venue surface the coordinator needs. Venue adapters and the simulated venue implement
// it; neither owns intent state.
export type ExecutionVenuePort = {
  placeOrder(intent: OrderIntent): Promise<VenueWriteResult<OrderAck>>;
  cancelOrder(request: CancelRequest): Promise<VenueWriteResult<CancelAck>>;
  lookupClientOrder(clientOrderId: ClientOrderId): Promise<ClientOrderLookup>;
  // Fresh snapshot of every open order in this market, owned or not. A rejected promise means
  // the read failed and proves nothing.
  listOpenOrders(): Promise<ExchangeOrderObservation[]>;
  // Executions of this market after the cursor, or from the start of the retained history for
  // a null cursor. A rejected promise means the read failed and proves nothing.
  listExecutionsSince(cursor: ExecutionCursor | null): Promise<ExecutionPage>;
};

// Fresh signed position and mark/mid price for the coordinator's market. Null, or a rejected
// promise, means the input is missing and blocks risk increase.
export type ExposureInputs = {
  signedPosition: DecimalString | null;
  markOrMidPrice: DecimalString | null;
};

export type ExposureInputSource = {
  read(): Promise<ExposureInputs>;
};

// The account, market, freshness and authority inputs of one risk evaluation. The coordinator
// supplies its own working orders and reservations, and never proposes a batch or halt
// authority through it.
export type RiskAccountInputs = Omit<
  RiskInput,
  "ownedActiveOrders" | "unknownReservations" | "proposedBatch" | "haltAuthorityClear"
>;

// Fresh risk inputs for the coordinator's scope. A rejected promise means the inputs are
// missing; anything that is not exactly a RiskAccountInputs fails the evaluation closed.
export type RiskInputSource = {
  read(): Promise<RiskAccountInputs>;
};

// What the durable halt authority says about continuing, as inspectHaltContinuation reports
// it. Only a proven RUNNING record that allows risk increase lets the gate continue.
export type HaltAuthorityView = {
  durableStatus: string;
  allowRiskIncrease: boolean;
  reasonCodes: string[];
};

// Read-only inspection of the durable halt record, lease, latch and process fence. A
// rejected promise means the halt authority is unavailable.
export type HaltAuthorityPort = {
  inspect(): Promise<HaltAuthorityView>;
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

// Durable store for the execution replay cursor. It is written only after the executions
// before it are durable in the intent journal; a rejection leaves the previous cursor.
export type ExecutionCheckpointStore = {
  persist(cursor: ExecutionCursor): Promise<void>;
};
