import { describe, expect, it } from "vitest";
import { navigationUrlForGoal } from "./cliBrowserDaemon.ts";

describe("navigationUrlForGoal", () => {
  it("normalizes natural language navigation goals", () => {
    expect(navigationUrlForGoal("navigate to google.com")).toBe(
      "https://google.com",
    );
    expect(navigationUrlForGoal("go to https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("rejects unsupported goals", () => {
    expect(navigationUrlForGoal("click the button")).toBeNull();
  });
});
