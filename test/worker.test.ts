import { describe, expect, it } from "vitest";
import { projectSlackIntent } from "../src/worker.js";

describe("Slack intent projection", () => {
  it("turns a report into agent-ready work state", () => {
    expect(projectSlackIntent([
      "Auth bug: Customer login fails after session refresh.",
      "The refresh cookie is not rotated.",
      "Return a new refresh cookie without ending the current session.",
      "Changing only the response body did not solve it.",
    ].join("\n"))).toEqual([
      { type: "objective", text: "Auth bug: Customer login fails after session refresh." },
      { type: "observation", text: "The refresh cookie is not rotated." },
      {
        type: "expected_result",
        text: "Return a new refresh cookie without ending the current session.",
      },
      {
        type: "constraint",
        text: "Return a new refresh cookie without ending the current session.",
      },
      { type: "failure", text: "Changing only the response body did not solve it." },
    ]);
  });
});
