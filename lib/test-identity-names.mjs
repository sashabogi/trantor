// Exact fixture families with numeric run IDs; a generic test/demo substring is not enough.
// Bare defer/supersede PID names come from test/handoff/test-handoff.mjs (#11501).
const TEST_NAME = /^(?:[A-Za-z0-9.-]+[_:])?(?:(?:defer|supersede)-\d+|(?:relay-selftest|hoff-selftest|consumedby|tt-h5|pctest|trantor-handoff|trantor-supersede|trantor-defer|cap-e2e|injcap|manual-skill)-\d+(?:[_:.-][\w:.-]+)?)$/;
export const isTestIdentity = name => TEST_NAME.test(name);
