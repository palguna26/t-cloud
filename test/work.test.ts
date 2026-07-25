import { describe, expect, it } from "vitest";
import { searchTerms } from "../src/work.js";

describe("intent search", () => {
  it("keeps source wording for PostgreSQL matching", () => {
    expect([...searchTerms("Fix that auth bug.")]).toEqual(["auth", "bug"]);
  });
});
