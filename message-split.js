// message-split.js — Telegram 消息切分：双换行分自然段 + 单条 4096 上限硬切兜底

// TG 单条上限 4096 字符，留余量取 4000：超长段不硬切会让 sendMessage 整条失败，Alice 收不到回复
export const TG_SEGMENT_LIMIT = 4000;

export function hardChunk(segment, limit = TG_SEGMENT_LIMIT) {
  if (segment.length <= limit) return [segment];
  const chunks = [];
  let rest = segment;
  while (rest.length > limit) {
    // 优先在换行/空格处断；都太靠前就在 limit 处硬切
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function splitMessages(text) {
  if (!text) return [];
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .flatMap((s) => hardChunk(s));
}
