import { expect, test, describe } from "bun:test";
import { romanToInt } from "./cheatTarget.ts";

describe("romanToInt", () => {
  test("I = 1", () => expect(romanToInt("I")).toBe(1));
  test("V = 5", () => expect(romanToInt("V")).toBe(5));
  test("III = 3", () => expect(romanToInt("III")).toBe(3));
  test("IV = 4", () => expect(romanToInt("IV")).toBe(4));
  test("IX = 9", () => expect(romanToInt("IX")).toBe(9));
  test("LVIII = 58", () => expect(romanToInt("LVIII")).toBe(58));
  test("MCMXCIV = 1994", () => expect(romanToInt("MCMXCIV")).toBe(1994));
  test("MMXXVI = 2026", () => expect(romanToInt("MMXXVI")).toBe(2026));
});
