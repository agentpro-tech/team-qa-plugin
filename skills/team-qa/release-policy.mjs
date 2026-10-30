export const RELEASE_POLICY = Object.freeze({
  finalizerOnly: true,
  orderedTransitions: true,
  sealedGateReceipts: true,
  jsonVerdictsOnly: true,
  bindRunCommitBase: true,
  deriveUiFromDiff: true,
  rejectBypass: true,
  requireAtomicCoverage: true,
  hashChainAttempts: true,
  crossControllerConformance: true,
  hostDeliveryHookAvailable: false,
  verifyFileMode: true,
});

export const EXECUTION_STATUS = Object.freeze(['completed', 'blocked', 'failed']);
export const SEMANTIC_VERDICT = Object.freeze(['PASS', 'PASS-STATIC', 'FAIL', 'UNGRADED']);
export const FINALIZER_DECISION = Object.freeze(['RELEASE_CANDIDATE', 'CUSTOMER_RETEST_READY', 'BLOCKED']);
export const GATE_EXIT = Object.freeze({ PASS: 0, 'PASS-STATIC': 0, FAIL: 1, UNGRADED: 20, USAGE: 2 });
