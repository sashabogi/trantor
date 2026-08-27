// Ported from the root test-desktop-transport.mjs drill — same eight assertions, same rule:
// the REAL module is imported, never a copy, or the test proves nothing about the code that ships.
import { describe, expect, it } from "vitest";
import { describeTransportFailure } from "./transport-errors";

const HUB = "http://100.79.242.104:4477";

describe("describeTransportFailure", () => {
  it("the restart case says what happened, in words", () => {
    expect(describeTransportFailure("error decoding response body", HUB)).toMatch(/lost contact/i);
  });

  it("…and does not repeat reqwest's phrasing at the operator", () => {
    expect(describeTransportFailure("error decoding response body", HUB)).not.toMatch(/decoding response body/i);
  });

  it("…and says it is retrying, so it does not read as a dead end", () => {
    expect(describeTransportFailure("error decoding response body", HUB)).toMatch(/retry/i);
  });

  it("a timeout is named as a timeout, with the hub it timed out on", () => {
    const msg = describeTransportFailure("operation timed out", HUB);
    expect(msg).toMatch(/did not answer/i);
    expect(msg).toContain(HUB);
  });

  it("an unreachable hub asks the two questions worth asking", () => {
    expect(describeTransportFailure("tcp connect error: Connection refused", HUB)).toMatch(/can't reach/i);
  });

  it("a DNS failure is distinguished from an unreachable host", () => {
    expect(describeTransportFailure("dns error: failed to lookup address", HUB)).toMatch(/resolve/i);
  });

  it("an UNRECOGNISED failure is passed through verbatim, never softened into a non-answer", () => {
    const weird = "some brand new failure nobody has seen";
    expect(describeTransportFailure(weird, HUB)).toBe(weird);
  });

  it("matching is case-insensitive (the string comes from a library, not from us)", () => {
    expect(describeTransportFailure("Error Decoding Response Body", HUB)).toMatch(/lost contact/i);
  });
});
