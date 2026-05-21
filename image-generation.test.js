import { describe, expect, test } from "bun:test";
import {
  buildCodexImageWorkerPrompt,
  buildImagePrompt,
  resolveImageProvider,
  resolveImageTimeoutMs,
} from "./image-generation.js";

describe("buildImagePrompt", () => {
  test("uses photorealistic Chinese portrait constraints for Codex self-portrait revisions", () => {
    const prompt = buildImagePrompt("画一个自画像，我想要帅哥，中国人，真实感，不要大叔，不要动漫", {
      ETWIN_DISPLAY_NAME: "Codex Twin",
      ETWIN_PERSONA: "codex",
    });

    expect(prompt).toContain("Codex Twin");
    expect(prompt).toContain("Photorealistic handsome Chinese man");
    expect(prompt).toContain("Chinese / East Asian facial features");
    expect(prompt).toContain("realistic cinematic photograph");
    expect(prompt).toContain("Avoid: anime, manga, illustration, digital painting, CGI, 3D render");
    expect(prompt).toContain("mature uncle");
  });

  test("uses the configured companion name for CC self-portrait requests", () => {
    const prompt = buildImagePrompt("你能画个自画像么？", { ETWIN_DISPLAY_NAME: "CC Twin", ETWIN_PERSONA: "cc" });

    expect(prompt).toContain("CC Twin");
    expect(prompt).not.toContain("Codex Twin");
  });
});

describe("resolveImageProvider", () => {
  test("defaults to Codex native image generation", () => {
    expect(resolveImageProvider({})).toBe("codex-native");
    expect(resolveImageProvider({ ETWIN_IMAGE_MODEL: "gemini-3-pro" })).toBe("codex-native");
  });

  test("only uses Gemini when explicitly selected", () => {
    expect(resolveImageProvider({ ETWIN_IMAGE_PROVIDER: "gemini" })).toBe("gemini");
  });
});

describe("resolveImageTimeoutMs", () => {
  test("uses a longer default for native image generation", () => {
    expect(resolveImageTimeoutMs({})).toBe(600000);
  });
});

describe("buildCodexImageWorkerPrompt", () => {
  test("forces built-in image_gen and blocks Gemini", () => {
    const prompt = buildCodexImageWorkerPrompt("画一个真实中国人头像", "/tmp/out.png");

    expect(prompt).toContain("built-in Codex image_gen");
    expect(prompt).toContain("Do not use Gemini");
    expect(prompt).toContain("/tmp/out.png");
    expect(prompt).toContain("SUCCESS: path=/tmp/out.png");
  });
});
