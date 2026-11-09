// Format tokens that people read in Team QA output and that code parses back (public v1).
// Team QA writes the English tokens. Readers also accept the tokens earlier versions wrote, so an RTM or a
// report from an older run still parses. Those legacy tokens are Vietnamese and are written as escapes.

// RTM: the requirement column header and the marker for a gap (a requirement with no case, a source with no case).
export const RTM_REQUIREMENT = 'Requirement';
export const RTM_EMPTY = '**EMPTY**';
export const LEGACY_RTM_REQUIREMENT = 'Y\u00eau c\u1ea7u';
export const LEGACY_RTM_EMPTY = '**TR\u1ed0NG**';
export const RTM_REQUIREMENT_HEADERS = [RTM_REQUIREMENT, LEGACY_RTM_REQUIREMENT];

export const isRtmEmpty = (cell) => cell === RTM_EMPTY || cell === LEGACY_RTM_EMPTY;
export const hasRtmEmpty = (text) => String(text).includes(RTM_EMPTY) || String(text).includes(LEGACY_RTM_EMPTY);
// The index of the requirement column in a list of header cells, whichever token the RTM was written with.
export const rtmRequirementIndex = (header) => {
  for (const name of RTM_REQUIREMENT_HEADERS) { const at = header.indexOf(name); if (at >= 0) return at; }
  return -1;
};
export const isRtmRequirementHeaderLine = (line) => RTM_REQUIREMENT_HEADERS.some((name) => String(line).includes(`| ${name} |`));

// The first words of a WAIT report: the run is not complete and says what is blocked.
export const WAIT_MARKER = 'NOT COMPLETE';
export const LEGACY_WAIT_MARKER = 'CH\u01afA HO\u00c0N TH\u00c0NH';
// Markdown around the marker does not change it: emphasis (**, __, *, _, ~~, `) is removed and a heading or quote
// mark in front of it is skipped, so `**NOT COMPLETE**` and `## NOT COMPLETE` start a WAIT report too.
export const stripLeadingMarkdown = (text) => String(text || '').replace(/[*_~`]/g, '').replace(/^[\s>#-]+/, '').trim();
export const startsWithWaitMarker = (text) => {
  const value = stripLeadingMarkdown(text);
  return value.startsWith(WAIT_MARKER) || value.startsWith(LEGACY_WAIT_MARKER);
};
