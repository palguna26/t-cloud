import { describe, expect, it } from "vitest";
import {
  hashAgentSecret,
  issueAgentCredential,
  parseAgentCredential,
} from "../src/agent-auth.js";

describe("agent credentials", () => {
  it("issues parseable credentials without storing the secret", () => {
    const pepper = "a".repeat(32);
    const issued = issueAgentCredential(pepper);
    const parsed = parseAgentCredential(issued.token);

    expect(parsed?.prefix).toBe(issued.prefix);
    expect(hashAgentSecret(parsed!.secret, pepper)).toEqual(issued.secretHash);
    expect(issued.secretHash.toString("utf8")).not.toContain(parsed!.secret);
  });

  it("rejects malformed credentials", () => {
    expect(parseAgentCredential("tyt_live_short_secret")).toBeNull();
    expect(parseAgentCredential("Bearer something")).toBeNull();
  });
});
