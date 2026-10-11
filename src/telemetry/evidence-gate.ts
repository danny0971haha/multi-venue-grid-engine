export type EvidenceResult = { ok: true } | { ok: false; reasonCodes: readonly string[] };

export type EvidenceGateDecision = {
  allowRiskIncrease: boolean;
  reasonCodes: string[];
};

/**
 * Applies RISK_PERSISTENCE_CONTRACT §23 to a risk-increasing operation: the required manifest and
 * events must be durably written first. Evidence can only deny. Telemetry success never grants
 * risk, and telemetry failure never clears a halt or a lease failure decided upstream.
 */
export function gateRiskIncreaseOnEvidence(
  upstream: { allowRiskIncrease: boolean; reasonCodes: readonly string[] },
  requiredEvidence: readonly EvidenceResult[],
): EvidenceGateDecision {
  const reasonCodes = [...upstream.reasonCodes];
  if (requiredEvidence.length === 0) {
    reasonCodes.push("TELEMETRY_EVIDENCE_NOT_SUPPLIED");
  }
  for (const evidence of requiredEvidence) {
    if (!evidence.ok) {
      reasonCodes.push(...evidence.reasonCodes);
    }
  }
  const evidenceOk = requiredEvidence.length > 0 && requiredEvidence.every((item) => item.ok);
  return {
    allowRiskIncrease: upstream.allowRiskIncrease && evidenceOk,
    reasonCodes: [...new Set(reasonCodes)],
  };
}
