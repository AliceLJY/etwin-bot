import { describe, expect, test } from "bun:test";
import { splitMessages, hardChunk, TG_SEGMENT_LIMIT } from "./message-split.js";

describe("splitMessages", () => {
  test("空输入返回空数组", () => {
    expect(splitMessages("")).toEqual([]);
    expect(splitMessages(null)).toEqual([]);
  });

  test("双换行分段并去空白", () => {
    expect(splitMessages("第一段\n\n第二段\n\n\n第三段  ")).toEqual(["第一段", "第二段", "第三段"]);
  });

  test("单段不超限时原样保留", () => {
    const seg = "啊".repeat(TG_SEGMENT_LIMIT);
    expect(splitMessages(seg)).toEqual([seg]);
  });

  // 回归：LLM 产出无双换行的超长段时曾整条发送失败，Alice 收不到回复
  test("无双换行的超长段被硬切，每段都在限内", () => {
    const long = "测".repeat(TG_SEGMENT_LIMIT * 2 + 500);
    const out = splitMessages(long);
    expect(out.length).toBeGreaterThan(1);
    for (const seg of out) expect(seg.length).toBeLessThanOrEqual(TG_SEGMENT_LIMIT);
    expect(out.join("")).toBe(long);
  });

  test("超长段优先在换行处断开", () => {
    const part = "行".repeat(3000);
    const text = `${part}\n${part}`;
    const out = hardChunk(text);
    expect(out[0]).toBe(part);
    expect(out[1]).toBe(part);
  });
});
