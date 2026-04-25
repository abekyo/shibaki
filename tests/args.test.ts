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

  test("--ask-human flag (canonical 名)", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--ask-human", "task"]);
    expect(a.ask).toBe(true);
  });

  test("--ask は --ask-human の alias (後方互換)", () => {
    const a = parseRunArgs(["--agent", "x", "--verify", "y", "--ask", "task"]);
    expect(a.ask).toBe(true);
  });
});

describe("parseRunArgs — 必須 args の missing は 1 回で報告 (round-trip 削減)", () => {
  // 旧挙動だと --agent → --verify → task と 3 回 throw して、ユーザーが
  // 3 回 invocation を直す必要があった。新挙動は 1 回ですべて報告。
  test("引数ゼロ: --agent / --verify / task が全部 1 message に列挙される", () => {
    let msg = "";
    try { parseRunArgs([]); } catch (e: any) { msg = e.message; }
    expect(msg).toContain("--agent");
    expect(msg).toContain("--verify");
    expect(msg).toContain("<task>");
    expect(msg).toContain("example");
  });

  test("--agent だけ指定: 残り 2 つを報告", () => {
    let msg = "";
    try { parseRunArgs(["--agent", "claude -p"]); } catch (e: any) { msg = e.message; }
    expect(msg).not.toContain("• --agent"); // 既に提供済み
    expect(msg).toContain("• --verify");
    expect(msg).toContain("• <task>");
  });

  test("--agent + --verify あり、task 無し: task のみ報告", () => {
    let msg = "";
    try { parseRunArgs(["--agent", "x", "--verify", "y"]); } catch (e: any) { msg = e.message; }
    expect(msg).not.toContain("• --agent");
    expect(msg).not.toContain("• --verify");
    expect(msg).toContain("• <task>");
  });
});
