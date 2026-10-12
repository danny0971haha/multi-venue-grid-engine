import type { LeaseTokenRequest } from "../persistence/runtime-lease.js";
import { runLeaseFencedMutation } from "../persistence/runtime-lease.js";
import type { FenceResult, MutationFence } from "./ports.js";

// Binds the coordinator's mutation fence to the runtime lease: every mutation re-proves the
// durable lease token, latch and fence state immediately before its callback runs.
export function createLeaseMutationFence(request: LeaseTokenRequest): MutationFence {
  return {
    leaseGeneration: request.authority.generation,
    async run<T>(mutation: () => Promise<T>): Promise<FenceResult<T>> {
      const result = await runLeaseFencedMutation({ ...request, mutation });
      return { outcome: result.outcome, value: result.value, reasonCodes: [...result.reasonCodes] };
    },
  };
}
