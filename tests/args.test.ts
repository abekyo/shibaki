import { expect, test, describe } from "bun:test";
import { parseRunArgs, ArgError } from "../src/cli/args.ts";

describe("parseRunArgs", () => {
  test("succeeds when required --agent / --verify / task are all present", () => {
    const a = parseRunArgs(["--agent", "claude -p", "--verify", "bun test", "task body"]);
    expect(a.agent).toBe("claude -p");
    expect(a.verify).toBe("bun test");
    expect(a.task).toBe("task body");
    expect(a.maxTries).toBe(10);
    expect(a.timeoutSec).toBe(1800);
  });

  test("missing --verify → ArgError (rejected)", () => {
    expect(() => parseRunArgs(["--agent", "claude -p", "task"])).toThrow(ArgError);
  });

  test("missing --agent → ArgError", () => {
    expect(() => parseRunArgs(["--verify", "bun test", "task"])).toThrow(ArgError);
  });

  test("empty task body → ArgError", () => {
    expect(() => parseRunArgs(["--agent", "x", "--verify", "y"])).toThrow(ArgError);
  });

  test("--max-tries / --timeout overrides", () => {
    const a = parseRunArgs([
      "--agent", "x", "--verify", "y",
      "--max-tries", "5", "--timeout", "60",
      "task",
    ]);
    expect(a.maxTries).toBe(5);
    expect(a.timeoutSec).toBe(60);
  });

  test("--max-tries clamps at 50", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--max-tries", "999", "task"]);
    expect(a.maxTries).toBe(50);
  });

  test("unknown option → ArgError", () => {
    expect(() => parseRunArgs(["--foo", "bar", "task"])).toThrow(ArgError);
  });

  test("--dry-run flag", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--dry-run", "task"]);
    expect(a.dryRun).toBe(true);
  });

  test("--ask-human flag (canonical name)", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--ask-human", "task"]);
    expect(a.ask).toBe(true);
  });

  test("--ask is an alias for --ask-human (backward compatibility)", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--ask", "task"]);
    expect(a.ask).toBe(true);
  });

  test("--quiet flag (long form)", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--quiet", "task"]);
    expect(a.quiet).toBe(true);
  });

  test("-q is an alias for --quiet (short form)", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "-q", "task"]);
    expect(a.quiet).toBe(true);
  });

  test("default: quiet is false", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "task"]);
    expect(a.quiet).toBe(false);
  });
});

describe("parseRunArgs — report all missing required args at once (reduce round-trips)", () => {
  // Old behavior threw 3 times for --agent → --verify → task, forcing the user
  // to fix invocation 3 times. New behavior reports all in one go.
  test("zero args: --agent / --verify / task all listed in one message", () => {
    let msg = "";
    try { parseRunArgs([]); } catch (e: any) { msg = e.message; }
    expect(msg).toContain("--agent");
    expect(msg).toContain("--verify");
    expect(msg).toContain("<task>");
    expect(msg).toContain("example");
  });

  test("only --agent provided: reports the other two", () => {
    let msg = "";
    try { parseRunArgs(["--agent", "claude -p"]); } catch (e: any) { msg = e.message; }
    expect(msg).not.toContain("• --agent"); // already provided
    expect(msg).toContain("• --verify");
    expect(msg).toContain("• <task>");
  });

  test("--agent + --verify present, no task: reports only task", () => {
    let msg = "";
    try { parseRunArgs(["--agent", "x", "--verify", "y"]); } catch (e: any) { msg = e.message; }
    expect(msg).not.toContain("• --agent");
    expect(msg).not.toContain("• --verify");
    expect(msg).toContain("• <task>");
  });
});
