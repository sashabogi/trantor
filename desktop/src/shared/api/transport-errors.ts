/** Transport failures, translated into something a person can act on.
 * Deliberately dependency-free: pure string mapping with nothing to mock, so it is unit-tested
 * directly under node.
 */

/** Turn a transport failure into a sentence a person can act on. These strings come from reqwest,
 * through Rust, and can sound like corrupt data when they are really routine (a body read
 * interrupted by a hub restart mid-deploy, for example). Translate, do not swallow: an
 * unrecognised failure passes through VERBATIM, since a false reassurance beats an ugly true one. */
export function describeTransportFailure(raw: string, baseUrl: string): string {
  const r = raw.toLowerCase();
  if (r.includes("decoding response body") || r.includes("error reading response") || r.includes("incomplete message")) {
    return "Lost contact with the hub while reading its reply — it was probably restarted. Retrying.";
  }
  if (r.includes("timed out") || r.includes("timeout")) {
    return `The hub at ${baseUrl} did not answer in time.`;
  }
  if (r.includes("connection refused") || r.includes("tcp connect") || r.includes("error sending request")) {
    return `Can't reach the hub at ${baseUrl}. Is it running, and are you on the tailnet?`;
  }
  if (r.includes("dns") || r.includes("resolve")) {
    return `Can't resolve the hub address ${baseUrl}.`;
  }
  return raw;
}
