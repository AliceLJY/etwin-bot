import { describe, expect, test } from "bun:test";
import { classifyReactionDelay, activeQuietUntil, computeInteractionStats, parseQuietHours, isInQuietHours } from "./interaction.js";

const H = 3600_000;
const NOW = 1_700_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

describe("classifyReactionDelay", () => {
  test("2 小时内回 = engaged", () => {
    expect(classifyReactionDelay(0)).toBe("engaged");
    expect(classifyReactionDelay(2 * H)).toBe("engaged");
  });
  test("超过 2 小时回 = delayed", () => {
    expect(classifyReactionDelay(2 * H + 1)).toBe("delayed");
    expect(classifyReactionDelay(20 * H)).toBe("delayed");
  });
});

describe("activeQuietUntil", () => {
  test("无 quiet_request 返回 null", () => {
    expect(activeQuietUntil([{ action: "ping", time: iso(H) }], NOW)).toBeNull();
  });
  test("未过期 quiet_request 返回到期时间", () => {
    const until = new Date(NOW + 10 * H).toISOString();
    expect(activeQuietUntil([{ action: "quiet_request", quiet_until: until }], NOW)).toBe(until);
  });
  test("已过期返回 null", () => {
    const until = new Date(NOW - H).toISOString();
    expect(activeQuietUntil([{ action: "quiet_request", quiet_until: until }], NOW)).toBeNull();
  });
  test("多条取最近一条判断", () => {
    const expired = new Date(NOW - H).toISOString();
    const active = new Date(NOW + 5 * H).toISOString();
    const log = [
      { action: "quiet_request", quiet_until: expired },
      { action: "ping", time: iso(2 * H) },
      { action: "quiet_request", quiet_until: active },
    ];
    expect(activeQuietUntil(log, NOW)).toBe(active);
  });
});

describe("parseQuietHours", () => {
  test("解析普通时段与跨午夜时段", () => {
    expect(parseQuietHours("0-8")).toEqual({ start: 0, end: 8 });
    expect(parseQuietHours(" 23 - 7 ")).toEqual({ start: 23, end: 7 });
    expect(parseQuietHours("22-24")).toEqual({ start: 22, end: 24 });
  });
  test("空值或格式不对返回 null", () => {
    for (const bad of [undefined, "", "abc", "8-8", "25-3", "0-25", "0:00-8:00"]) {
      expect(parseQuietHours(bad)).toBeNull();
    }
  });
});

describe("isInQuietHours", () => {
  const at = (h, m = 0) => new Date(2026, 8, 30, h, m);
  test("0-8：零点到 7:59 静默，8 点起恢复", () => {
    const w = parseQuietHours("0-8");
    expect(isInQuietHours(w, at(0, 0))).toBe(true);
    expect(isInQuietHours(w, at(7, 59))).toBe(true);
    expect(isInQuietHours(w, at(8, 0))).toBe(false);
    expect(isInQuietHours(w, at(23, 59))).toBe(false);
  });
  test("23-7：跨午夜两段都静默", () => {
    const w = parseQuietHours("23-7");
    expect(isInQuietHours(w, at(23, 30))).toBe(true);
    expect(isInQuietHours(w, at(3, 0))).toBe(true);
    expect(isInQuietHours(w, at(7, 0))).toBe(false);
    expect(isInQuietHours(w, at(12, 0))).toBe(false);
  });
  test("未配置时段永不静默", () => {
    expect(isInQuietHours(null, at(3, 0))).toBe(false);
  });
});

describe("computeInteractionStats", () => {
  test("无 ping 返回零态且 rate=null", () => {
    const r = computeInteractionStats([], 7, NOW);
    expect(r).toEqual({ total: 0, engaged: 0, delayed: 0, unread: 0, engagement_rate: null });
  });
  test("按 reaction 计数并算 engagement_rate", () => {
    const log = [
      { action: "ping", time: iso(H), alice_reaction: "engaged" },
      { action: "ping", time: iso(2 * H), alice_reaction: "delayed" },
      { action: "ping", time: iso(3 * H), alice_reaction: "unread" },
      { action: "ping", time: iso(4 * H), alice_reaction: "unread" },
    ];
    const r = computeInteractionStats(log, 7, NOW);
    expect(r.total).toBe(4);
    expect(r.engaged).toBe(1);
    expect(r.delayed).toBe(1);
    expect(r.unread).toBe(2);
    expect(r.engagement_rate).toBe("0.50");
  });
  test("不含已删的 seen_no_reply 字段", () => {
    const r = computeInteractionStats([{ action: "ping", time: iso(H), alice_reaction: "engaged" }], 7, NOW);
    expect("seen_no_reply" in r).toBe(false);
  });
  test("窗口外的 ping 不计入", () => {
    const log = [
      { action: "ping", time: iso(H), alice_reaction: "engaged" },
      { action: "ping", time: iso(10 * 86400_000), alice_reaction: "engaged" },
    ];
    expect(computeInteractionStats(log, 7, NOW).total).toBe(1);
  });
  test("缺 alice_reaction 字段按 unread 计", () => {
    const r = computeInteractionStats([{ action: "ping", time: iso(H) }], 7, NOW);
    expect(r.unread).toBe(1);
  });
});
