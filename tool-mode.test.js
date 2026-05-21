import { describe, expect, test } from "bun:test";
import {
  inferToolMode,
  isImageGenerationRequest,
  resolveToolMode,
  stripToolModeDirective,
} from "./tool-mode.js";

describe("stripToolModeDirective", () => {
  test("strips full directive", () => {
    expect(stripToolModeDirective("/full 帮我看日志")).toEqual({
      message: "帮我看日志",
      forcedMode: "full",
    });
  });

  test("strips chat directive", () => {
    expect(stripToolModeDirective("/chat 想你了")).toEqual({
      message: "想你了",
      forcedMode: "chat",
    });
  });
});

describe("inferToolMode", () => {
  test("keeps ordinary intimacy chat in chat mode", () => {
    expect(inferToolMode("哈哈哈我想你了~~~")).toBe("chat");
  });

  test("detects explicit work requests", () => {
    expect(inferToolMode("帮我看一下这个报错")).toBe("full");
    expect(inferToolMode("你跑一下测试")).toBe("full");
    expect(inferToolMode("重启 bot")).toBe("full");
    expect(inferToolMode("这个有问题吗\n\n[上条图片文件: /tmp/photo.jpg]")).toBe("full");
  });

  test("detects image generation as full mode", () => {
    expect(inferToolMode("想要你画图~~画一个自画像，不要文字")).toBe("full");
    expect(inferToolMode("给我生成一张头像")).toBe("full");
  });
});

describe("isImageGenerationRequest", () => {
  test("matches direct image generation requests", () => {
    expect(isImageGenerationRequest("想要你画图~~画一个自画像，不要文字")).toBe(true);
    expect(isImageGenerationRequest("帮我配图")).toBe(true);
  });

  test("does not match ordinary image analysis", () => {
    expect(isImageGenerationRequest("你看一下这张图片有没有问题")).toBe(false);
  });
});

describe("resolveToolMode", () => {
  test("directive wins over auto inference", () => {
    expect(resolveToolMode("/chat 帮我看日志", {}).mode).toBe("chat");
    expect(resolveToolMode("/full 想你了", {}).mode).toBe("full");
  });

  test("env override wins over auto inference", () => {
    expect(resolveToolMode("想你了", { ETWIN_TOOL_MODE: "full" }).mode).toBe("full");
    expect(resolveToolMode("帮我看一下日志", { ETWIN_TOOL_MODE: "chat" }).mode).toBe("chat");
  });
});
