import { expect, test, describe } from "bun:test";
import { parseRunArgs, ArgError } from "../src/cli/args.ts";

describe("parseRunArgs", () => {
  test("必須 --agent / --verify / task が揃えば成功", () => {
    const a = parseRunArgs(["--agent", "claude -p", "--verify", "bun test", "task body"]);
    expect(a.agent).toBe("claude -p");
    expect(a.verify).toBe("bun test");
    expect(a.task).toBe("task body");
    expect(a.maxTries).toBe(10);
    expect(a.timeoutSec).toBe(1800);
  });

  test("--verify 未指定は ArgError (受理拒否)", () => {
    expect(() => parseRunArgs(["--agent", "claude -p", "task"])).toThrow(ArgError);
  });

  test("--agent 未指定は ArgError", () => {
    expect(() => parseRunArgs(["--verify", "bun test", "task"])).toThrow(ArgError);
  });

  test("タスク本文が空は ArgError", () => {
    expect(() => parseRunArgs(["--agent", "x", "--verify", "y"])).toThrow(ArgError);
  });

  test("--max-tries / --timeout の上書き", () => {
    const a = parseRunArgs([
      "--agent", "x", "--verify", "y",
      "--max-tries", "5", "--timeout", "60",
      "task",
    ]);
    expect(a.maxTries).toBe(5);
    expect(a.timeoutSec).toBe(60);
  });

  test("--max-tries は 50 でクランプ", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--max-tries", "999", "task"]);
    expect(a.maxTries).toBe(50);
  });

  test("未知オプションは ArgError", () => {
    expect(() => parseRunArgs(["--foo", "bar", "task"])).toThrow(ArgError);
  });

  test("--dry-run flag", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--dry-run", "task"]);
    expect(a.dryRun).toBe(true);
  });
});
