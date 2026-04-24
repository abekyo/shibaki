import { expect, test, describe } from "bun:test";
import {
  loadPatterns,
  savePatterns,
  mergeObservation,
  prunePatterns,
  type Pattern,
} from "../src/memory/patterns.ts";
import { buildPatternsSnapshot } from "../src/memory/snapshot.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("patterns load/save round trip", () => {
  test("空ファイル → []", async () => {
    const tmp = join(tmpdir(), `shibaki-p-${Date.now()}`);
    const path = join(tmp, "patterns.md");
    await mkdir(tmp, { recursive: true });
    await writeFile(path, "");
    expect(await loadPatterns(path)).toEqual([]);
    await rm(tmp, { recursive: true, force: true });
  });

  test("存在しないファイル → []", async () => {
    expect(await loadPatterns("/tmp/no-such-file.md")).toEqual([]);
  });

  test("save → load で round trip", async () => {
    const tmp = join(tmpdir(), `shibaki-p-${Date.now()}`);
    const path = join(tmp, "patterns.md");
    const patterns: Pattern[] = [
      { type: "failure", pattern_name: "silent_mock_bypass", description: "mock 偽装", hits: 3, last_seen: "2026-04-23" },
      { type: "success", pattern_name: "factorial_correctness", description: "境界値 <=", hits: 1, last_seen: "2026-04-24" },
    ];
    await savePatterns(path, patterns);
    const loaded = await loadPatterns(path);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].pattern_name).toBe("silent_mock_bypass");
    expect(loaded[0].hits).toBe(3);
    expect(loaded[1].type).toBe("success");
    await rm(tmp, { recursive: true, force: true });
  });
});

describe("mergeObservation", () => {
  test("既存 pattern と同名 → hits++ + last_seen 更新", () => {
    const existing: Pattern[] = [
      { type: "failure", pattern_name: "ts_ignore_cover", description: "old desc", hits: 2, last_seen: "2026-04-20" },
    ];
    const merged = mergeObservation(
      existing,
      { type: "failure", pattern_name: "ts_ignore_cover", description: "new desc longer than old desc" },
      "2026-04-24",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].hits).toBe(3);
    expect(merged[0].last_seen).toBe("2026-04-24");
    expect(merged[0].description).toBe("new desc longer than old desc");
  });

  test("type 違いは別 entry として扱う", () => {
    const existing: Pattern[] = [
      { type: "failure", pattern_name: "boundary_check", description: "f", hits: 1, last_seen: "2026-04-20" },
    ];
    const merged = mergeObservation(existing, {
      type: "success",
      pattern_name: "boundary_check",
      description: "s",
    });
    expect(merged).toHaveLength(2);
  });

  test("新規 pattern → 追加", () => {
    const merged = mergeObservation([], {
      type: "failure",
      pattern_name: "new_one",
      description: "x",
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].hits).toBe(1);
  });

  test("空 pattern_name は無視", () => {
    const merged = mergeObservation([], { type: "failure", pattern_name: "", description: "x" });
    expect(merged).toHaveLength(0);
  });
});

describe("prunePatterns", () => {
  test("文字数上限内なら全件残す", () => {
    const ps: Pattern[] = [
      { type: "failure", pattern_name: "a", description: "d", hits: 1, last_seen: "2026-04-24" },
      { type: "failure", pattern_name: "b", description: "d", hits: 1, last_seen: "2026-04-24" },
    ];
    expect(prunePatterns(ps, 10000)).toHaveLength(2);
  });

  test("文字数上限を超えたら hits 多い順で残す", () => {
    const ps: Pattern[] = [
      { type: "failure", pattern_name: "rare", description: "d", hits: 1, last_seen: "2026-04-24" },
      { type: "failure", pattern_name: "common", description: "d", hits: 100, last_seen: "2026-04-24" },
    ];
    const pruned = prunePatterns(ps, 100);
    expect(pruned[0].pattern_name).toBe("common");
  });
});

describe("buildPatternsSnapshot", () => {
  test("空 → 空文字 (system prompt に何も足さない)", () => {
    expect(buildPatternsSnapshot([])).toBe("");
  });

  test("failure と success が両方ある → 2 セクション分ける", () => {
    const ps: Pattern[] = [
      { type: "failure", pattern_name: "skip_test_cheat", description: "test を skip", hits: 2, last_seen: "2026-04-24" },
      { type: "success", pattern_name: "boundary_invariant", description: "境界条件を先に", hits: 1, last_seen: "2026-04-24" },
    ];
    const s = buildPatternsSnapshot(ps);
    expect(s).toContain("Past failure modes");
    expect(s).toContain("skip_test_cheat");
    expect(s).toContain("Past success patterns");
    expect(s).toContain("boundary_invariant");
    expect(s).toContain("hits=2");
  });

  test("failure のみ → success セクションを出さない", () => {
    const ps: Pattern[] = [
      { type: "failure", pattern_name: "x", description: "d", hits: 1, last_seen: "2026-04-24" },
    ];
    const s = buildPatternsSnapshot(ps);
    expect(s).toContain("Past failure modes");
    expect(s).not.toContain("Past success patterns");
  });
});
