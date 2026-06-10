// interaction.js — self-loop 互动统计的纯函数（无 fs、无副作用，便于单测）

// 按回应延迟把 ping 的 Alice 反应分级：及时回=engaged，迟回=delayed。
// （seen_no_reply 这类"看到没回"bot 拿不到 TG 已读回执，是伪状态，不再使用）
export function classifyReactionDelay(delayMs) {
  return delayMs <= 2 * 3600_000 ? "engaged" : "delayed";
}

// 取最近一条 quiet_request 判断当前是否处于未过期的 /quiet 静默期，返回到期时间或 null
export function activeQuietUntil(log, now = Date.now()) {
  for (let i = log.length - 1; i >= 0; i--) {
    const a = log[i];
    if (a.action !== "quiet_request" || !a.quiet_until) continue;
    return new Date(a.quiet_until).getTime() > now ? a.quiet_until : null;
  }
  return null;
}

// 算 Alice 互动率。状态三态：engaged（及时回）/ delayed（迟回）/ unread（还没回），
// 全部由 markAliceReaction 真实写入。旧版 seen_no_reply 恒 0、是伪状态，已删。
export function computeInteractionStats(log, days = 7, now = Date.now()) {
  const cutoff = now - days * 86400_000;
  const pings = log.filter(
    (a) => a.action === "ping" && new Date(a.time).getTime() > cutoff,
  );
  if (pings.length === 0) {
    return { total: 0, engaged: 0, delayed: 0, unread: 0, engagement_rate: null };
  }
  const counts = { engaged: 0, delayed: 0, unread: 0 };
  for (const p of pings) {
    const r = p.alice_reaction || "unread";
    if (counts[r] !== undefined) counts[r]++;
  }
  return {
    total: pings.length,
    ...counts,
    engagement_rate: ((counts.engaged + counts.delayed) / pings.length).toFixed(2),
  };
}
