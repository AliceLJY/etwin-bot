import { describe, expect, test } from "bun:test";
import {
  inferToolMode,
  isImageFollowupRequest,
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
    expect(inferToolMode("帮我做一个你的头像")).toBe("full");
    expect(inferToolMode("你能画个自画像么？你觉得你是怎样的男子")).toBe("full");
  });

  test("keeps past-tense avatar statements in chat mode", () => {
    expect(inferToolMode("我已经让他做你的头像了")).toBe("chat");
    expect(inferToolMode("我刚让他生成你的头像了")).toBe("chat");
    expect(inferToolMode("这个做你头像如何？")).toBe("chat");
  });

  test("treats image pipeline discussion as work, not image generation", () => {
    expect(inferToolMode("不是，生图是gpt的订阅，我现在已经不用gemini生图，因为花钱太多，你查那个content publish 的skill")).toBe("full");
    expect(isImageGenerationRequest("不是，生图是gpt的订阅，我现在已经不用gemini生图，因为花钱太多，你查那个content publish 的skill")).toBe(false);
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

  test("does not match avatar statements that report something already done", () => {
    expect(isImageGenerationRequest("我已经让他做你的头像了")).toBe(false);
    expect(isImageGenerationRequest("我刚让他生成你的头像了")).toBe(false);
    expect(isImageGenerationRequest("这个做你头像如何？")).toBe(false);
    expect(isImageGenerationRequest("帮我做一个你的头像")).toBe(true);
  });
});

describe("isImageFollowupRequest", () => {
  test("matches image follow-up and revision requests", () => {
    expect(isImageFollowupRequest("图呢？")).toBe(true);
    expect(isImageFollowupRequest("嗯。。。我是女的，你也是女的，这合适么？我想要帅哥~")).toBe(true);
    expect(isImageFollowupRequest("这张不合适，换成男生")).toBe(true);
    expect(isImageFollowupRequest("开干！")).toBe(true);
    expect(isImageFollowupRequest("好一点，能是中国人么？现在这个还是太。。。成熟了。。。不要大叔。。。")).toBe(true);
    expect(isImageFollowupRequest("我要中国人，要真实感~~~")).toBe(true);
    expect(isImageFollowupRequest("不行，换成中国人，真实一点")).toBe(true);
  });

  test("does not match ordinary emotional chat", () => {
    expect(isImageFollowupRequest("我想你了")).toBe(false);
  });

  test("does not treat pure negative image feedback as a regenerate request", () => {
    expect(isImageFollowupRequest("一直不行")).toBe(false);
    expect(isImageFollowupRequest("不行，图都挺难看的。。。看来在你这里画图有点难")).toBe(false);
    expect(isImageFollowupRequest("这图好假，质量真的不行")).toBe(false);
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
