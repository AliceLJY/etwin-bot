import { describe, expect, test } from "bun:test";
import { lstatSync, readFileSync } from "fs";
import { join } from "path";

const PERSONA_FILES = ["digital-clone-base.md", "digital-clone-profile.md"];

describe("public persona templates", () => {
  for (const filename of PERSONA_FILES) {
    test(`${filename} is a usable regular file in a clean clone`, () => {
      const path = join(import.meta.dir, "persona", filename);
      const stat = lstatSync(path);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      expect(readFileSync(path, "utf-8").trim().length).toBeGreaterThan(100);
    });
  }
});
