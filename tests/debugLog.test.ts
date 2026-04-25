// Contract tests for debugLog output location and filename format.
// Consolidates under ~/.shibaki/logs/ to avoid the past problem of cwd-relative .shibaki/ scatter.
import { expect, test, describe } from "bun:test";
import { rm, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDebugLog } from "../src/loop/debugLog.ts";

describe("openDebugLog — output location", () => {
  test("writes under ~/.shibaki/logs/ (not under cwd)", async () => {
    const cwd = "/tmp/some-fake-project";
    const logger = await openDebugLog(cwd);
    try {
      // path is under ~/.shibaki/logs/
      const expectedDir = join(homedir(), ".shibaki", "logs");
      expect(logger.path.startsWith(expectedDir + "/") || logger.path.startsWith(expectedDir + "\\")).toBe(true);
      // not created inside cwd
      expect(logger.path).not.toContain(cwd);
      // file exists
      const s = await stat(logger.path);
      expect(s.isFile()).toBe(true);
    } finally {
      await rm(logger.path, { force: true });
    }
  });

  test("filename contains project basename (so logs across repos grep cleanly)", async () => {
    const logger = await openDebugLog("/tmp/myproject-foo");
    try {
      // basename "myproject-foo" should appear in filename
      expect(logger.path).toContain("myproject-foo");
    } finally {
      await rm(logger.path, { force: true });
    }
  });

  test("first record records cwd (disambiguator for basename collisions)", async () => {
    const cwd = "/tmp/foo/bar/projectX";
    const logger = await openDebugLog(cwd);
    try {
      const content = await readFile(logger.path, "utf8");
      const firstLine = content.split("\n")[0];
      const obj = JSON.parse(firstLine);
      expect(obj.kind).toBe("session_meta");
      expect(obj.cwd).toBe(cwd);
    } finally {
      await rm(logger.path, { force: true });
    }
  });

  test("invalid filename characters are sanitized", async () => {
    const cwd = "/tmp/with spaces and / slashes";
    const logger = await openDebugLog(cwd);
    try {
      // basename = "with spaces and " (before trailing slash) → spaces etc. sanitized to _
      // path contains no whitespace / slashes (in the basename-derived portion)
      const fname = logger.path.split("/").pop()!;
      expect(fname).not.toMatch(/[ ]/);
    } finally {
      await rm(logger.path, { force: true });
    }
  });
});
