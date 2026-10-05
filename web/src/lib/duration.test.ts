import { describe, expect, test } from "vitest";
import { formatDuration, parseDurationText } from "./duration";

describe("parseDurationText", () => {
  test("parses all documented shapes", () => {
    expect(parseDurationText("80h 3m")).toBe(4803);
    expect(parseDurationText("80:03")).toBe(4803);
    expect(parseDurationText("90m")).toBe(90);
    expect(parseDurationText("2h")).toBe(120);
    expect(parseDurationText("90")).toBe(90);
    expect(parseDurationText("1.5h")).toBe(90);
    expect(parseDurationText("2H 30M")).toBe(150);
    expect(parseDurationText("1h30m")).toBe(90);
  });

  test("rejects garbage like the server", () => {
    expect(parseDurationText("")).toBeNull();
    expect(parseDurationText("abc")).toBeNull();
    expect(parseDurationText("80:75")).toBeNull();
    expect(parseDurationText("-5m")).toBeNull();
    expect(parseDurationText("h")).toBeNull();
  });
});

describe("formatDuration", () => {
  test("normalizes beyond 60 minutes", () => {
    expect(formatDuration(0)).toBe("0h 0m");
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(4803)).toBe("80h 3m");
    expect(formatDuration(8247)).toBe("137h 27m");
    expect(formatDuration(556.4)).toBe("9h 16m");
  });
});
