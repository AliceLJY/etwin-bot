import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";


describe("launchd templates", () => {
  test("render portable private plist files", () => {
    const root = import.meta.dir;
    const temporaryRoot = mkdtempSync(join(tmpdir(), "etwin-launchd-test-"));
    const fakeHome = join(temporaryRoot, "home & data");
    const destinationDir = join(temporaryRoot, "LaunchAgents & Test");
    try {
      const result = spawnSync(join(root, "install-launchd.sh"), [], {
        cwd: root,
        env: {
          ...process.env,
          HOME: fakeHome,
          ETWIN_LAUNCHD_DEST_DIR: destinationDir,
        },
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      for (const label of ["com.etwin-bot", "com.etwin-codex-bot"]) {
        const path = join(destinationDir, `${label}.plist`);
        const contents = readFileSync(path, "utf-8");
        expect(contents).toContain(root);
        expect(contents).toContain(fakeHome.replaceAll("&", "&amp;"));
        expect(contents).not.toContain("__ETWIN_ROOT__");
        expect(contents).not.toContain("__ETWIN_HOME__");
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }

      const codex = readFileSync(join(destinationDir, "com.etwin-codex-bot.plist"), "utf-8");
      expect(codex).toContain("ETWIN_ENV_FILE");
      expect(codex).toContain(".env.codex");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
