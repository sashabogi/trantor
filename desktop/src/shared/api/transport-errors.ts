/** Transport failures, translated into something a person can act on.
 *
 * Deliberately dependency-free so it can be unit-tested directly (node strips the types), and
 * because this is pure string mapping with nothing to mock.
 */

/** Turn a transport failure into a sentence a person can act on.
 *
 * These strings come from reqwest, through Rust, and land in front of whoever opened the app. The
 * one that prompted this was "error decoding response body", which sounds like corrupt data and is
 * not: it is what reqwest says when the BODY READ is interrupted — most often because the hub was
 * restarted mid-request, which happens on every deploy and is entirely routine. A person read that
 * as their data being broken.
 *
 * Translate, do not swallow. An unrecognised failure is passed through VERBATIM rather than
 * flattened into a friendly non-answer: a wrong reassuring message is worse than an ugly true one,
 * and the raw text is what makes a bug report useful.
 */
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
