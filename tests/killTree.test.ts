// Test: killAllChildren reaps the subprocess tree promptly. The motivation:
// without `detached: true` + kill(-pid), Ctrl-C while a `claude` agent is
// running leaves it as an orphan still hitting the API (= billing for nothing).
import { expect, test, describe } from "bun:test";
import { runMainAgent, killAllChildren } from "../src/agent/mainAgent.ts";

describe("killAllChildren", () => {
  test("子がいない状態で呼んでも throw しない (idempotent)", () => {
    expect(() => killAllChildren("SIGTERM")).not.toThrow();
    expect(() => killAllChildren("SIGTERM")).not.toThrow();
  });

  test("実行中の子プロセスは killAllChildren で素早く reap される", async () => {
    // 60s sleep (本番では claude や bun test に相当する長時間 child) を起動
    const p = runMainAgent({
      agentCmd: "sleep 60",
      task: "x",
      cwd: "/tmp",
      timeoutMs: 120_000, // sleep より十分長い → 自然 timeout 待ちでは絶対終わらない
    });

    // child が立ち上がるのを待つ
    await new Promise((r) => setTimeout(r, 200));

    const t0 = Date.now();
    killAllChildren("SIGTERM");

    // killAllChildren 後、runMainAgent は速やかに resolve するべき
    // (signal が child process group まで届いてれば)
    const result = await Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("runMainAgent did not resolve within 5s after killAllChildren")), 5000),
      ),
    ]);
    const elapsed = Date.now() - t0;

    // sleep 60 が 3 秒以内に resolve した = kill が効いた。
    // (node spawn は signal 死だと close の code=null → exitCode 0 になるので
    //  exitCode 自体は判定材料にならない。時間で判定する)
    expect(elapsed).toBeLessThan(3000);
    expect(result).toBeDefined();
  }, 15_000);

  test("複数の並行 child を 1 回の killAllChildren で全部殺せる", async () => {
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
