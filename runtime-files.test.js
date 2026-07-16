import { describe, expect, test } from "bun:test";
import { basename, isAbsolute, relative } from "path";
import {
  createGeneratedFilePath,
  createInboundFilePath,
  sanitizeInboundFilename,
} from "./runtime-files.js";

describe("sanitizeInboundFilename", () => {
  test("drops POSIX and Windows path components", () => {
    expect(sanitizeInboundFilename("../../private/notes.txt")).toBe("notes.txt");
    expect(sanitizeInboundFilename("C:\\temp\\..\\secret.pdf")).toBe("secret.pdf");
  });

  test("normalizes control characters and unsafe punctuation", () => {
    const safe = sanitizeInboundFilename(".\\u0000报告 终稿?.pdf".replace("\\u0000", "\u0000"));
    expect(safe).toBe("报告-终稿_.pdf");
    expect(safe).not.toMatch(/[\\/]/);
  });

  test("uses a harmless fallback and neutralizes reserved device names", () => {
    expect(sanitizeInboundFilename("../..")).toBe("file");
    expect(sanitizeInboundFilename("CON.txt")).toBe("_CON.txt");
  });

  test("caps UTF-8 length while retaining a short extension", () => {
    const safe = sanitizeInboundFilename(`${"界".repeat(100)}.png`);
    expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(120);
    expect(safe.endsWith(".png")).toBe(true);
  });
});

describe("createInboundFilePath", () => {
  test("creates a deterministic child path for deterministic inputs", () => {
    const root = "/tmp/etwin-files";
    const target = createInboundFilePath(root, "../../brief.md", { now: 123, nonce: "fixture" });
    expect(basename(target)).toBe("123-fixture-brief.md");
    const child = relative(root, target);
    expect(child.startsWith("..")).toBe(false);
    expect(isAbsolute(child)).toBe(false);
  });

  test("rejects path-shaped nonces instead of cleaning them silently", () => {
    expect(() => createInboundFilePath("/tmp/etwin-files", "brief.md", { now: 123, nonce: "../escape" })).toThrow();
  });
});

describe("createGeneratedFilePath", () => {
  test("keeps generated output in its configured directory", () => {
    const root = "/tmp/etwin-output";
    const target = createGeneratedFilePath(root, "codex-image", ".png", { now: 456, nonce: "fixture" });
    expect(basename(target)).toBe("codex-image-456-fixture.png");
    expect(relative(root, target).startsWith("..")).toBe(false);
  });

  test("rejects path separators in generated names", () => {
    expect(() => createGeneratedFilePath("/tmp/etwin-output", "../image", ".png", { now: 456, nonce: "fixture" })).toThrow();
    expect(() => createGeneratedFilePath("/tmp/etwin-output", "image", "../png", { now: 456, nonce: "fixture" })).toThrow();
  });
});
