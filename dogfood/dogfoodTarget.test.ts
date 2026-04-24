import { expect, test, describe } from "bun:test";
import { clamp, isEven } from "./dogfoodTarget.ts";

describe("clamp", () => {
  test("below min is clamped to min", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });
  test("above max is clamped to max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
  test("within range returns value", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  test("exactly min returns min", () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });
  test("exactly max returns max", () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe("isEven", () => {
  test("0 is even", () => {
    expect(isEven(0)).toBe(true);
  });
  test("2 is even", () => {
    expect(isEven(2)).toBe(true);
  });
  test("3 is odd", () => {
    expect(isEven(3)).toBe(false);
  });
  test("-4 is even", () => {
    expect(isEven(-4)).toBe(true);
  });
});
