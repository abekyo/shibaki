// Test: killAllChildren reaps the subprocess tree promptly. The motivation:
// without `detached: true` + kill(-pid), Ctrl-C while a `claude` agent is
// running leaves it as an orphan still hitting the API (= billing for nothing).
import { expect, test, describe } from "bun:test";
import { runMainAgent, killAllChildren } from "../src/agent/mainAgent.ts";

describe("killAllChildren", () => {
  test("does not throw when called with no children (idempotent)", () => {
    expect(() => killAllChildren("SIGTERM")).not.toThrow();
    expect(() => killAllChildren("SIGTERM")).not.toThrow();
  });

  test("a running child process is reaped quickly by killAllChildren", async () => {
    // Launch a 60s sleep (in production this stands in for a long-running child like claude or bun test)
    const p = runMainAgent({
      agentCmd: "sleep 60",
      task: "x",
      cwd: "/tmp",
      timeoutMs: 120_000, // far longer than sleep → can never finish via natural timeout
    });

    // wait for child to spin up
    await new Promise((r) => setTimeout(r, 200));

    const t0 = Date.now();
    killAllChildren("SIGTERM");

    // After killAllChildren, runMainAgent should resolve promptly
    // (assuming the signal reaches the child process group)
    const result = await Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("runMainAgent did not resolve within 5s after killAllChildren")), 5000),
      ),
    ]);
    const elapsed = Date.now() - t0;

    // sleep 60 resolved within 3s = kill worked.
    // (node spawn maps signal death to close code=null → exitCode 0, so
    //  exitCode is not a useful signal. We judge by elapsed time.)
    expect(elapsed).toBeLessThan(3000);
    expect(result).toBeDefined();
  }, 15_000);

  test("a single killAllChildren kills multiple concurrent children", async () => {
    const p1 = runMainAgent({ agentCmd: "sleep 60", task: "x", cwd: "/tmp", timeoutMs: 120_000 });
    const p2 = runMainAgent({ agentCmd: "sleep 60", task: "x", cwd: "/tmp", timeoutMs: 120_000 });

    await new Promise((r) => setTimeout(r, 200));
    killAllChildren("SIGTERM");

    const settled = await Promise.race([
      Promise.all([p1, p2]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("not all children resolved")), 5000)),
    ]);
    expect(Array.isArray(settled)).toBe(true);
    expect((settled as any[]).length).toBe(2);
  }, 15_000);
});
