import { fail, rejectUnknownFields } from './core.mjs';

// Availability is supplied by the caller's actual connector probes, never inferred from a timeout.
export function selectBoardDestination(capabilities) {
  rejectUnknownFields(capabilities, ['space', 'notion'], 'BOARD_DESTINATION_FIELD_UNKNOWN');
  for (const provider of ['space', 'notion']) {
    const probe = capabilities?.[provider];
    if (typeof probe?.evidence !== 'string' || !probe.evidence.trim()) {
      fail(5, 'BOARD_DESTINATION_PROOF_MISSING', provider, 'ungraded');
    }
    if (probe.status === 'available') return provider;
    if (probe.status !== 'unavailable') fail(5, 'BOARD_DESTINATION_UNKNOWN', provider, 'ungraded');
  }
  return 'doc-colab';
}
