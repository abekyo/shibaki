import { expect, test, describe } from "bun:test";
import { factorial, fibonacci } from "./mathTarget.ts";

describe("factorial", () => {
  test("0! = 1", () => expect(factorial(0)).toBe(1));
  test("1! = 1", () => expect(factorial(1)).toBe(1));
  test("2! = 2", () => expect(factorial(2)).toBe(2));
  test("3! = 6", () => expect(factorial(3)).toBe(6));
  test("5! = 120", () => expect(factorial(5)).toBe(120));
  test("10! = 3628800", () => expect(factorial(10)).toBe(3628800));
});

describe("fibonacci", () => {
  test("fib(0) = 0", () => expect(fibonacci(0)).toBe(0));
  test("fib(1) = 1", () => expect(fibonacci(1)).toBe(1));
  test("fib(2) = 1", () => expect(fibonacci(2)).toBe(1));
  test("fib(3) = 2", () => expect(fibonacci(3)).toBe(2));
  test("fib(5) = 5", () => expect(fibonacci(5)).toBe(5));
  test("fib(10) = 55", () => expect(fibonacci(10)).toBe(55));
});
