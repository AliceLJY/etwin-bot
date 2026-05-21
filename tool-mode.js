export const TOOL_MODE_AUTO = "auto";
export const TOOL_MODE_CHAT = "chat";
export const TOOL_MODE_FULL = "full";

const FULL_INTENT_PATTERNS = [
  /\[(?:上条图片文件|图片文件|文件|语音文件):/i,
  /(?:帮我|你)?(?:查|搜索|搜一下|联网|打开|读取|读一下|读|看看|看一下|看下).*(?:文件|代码|仓库|repo|github|网页|链接|日志|报错|截图|图片|配置|进程|服务|状态)/i,
  /(?:帮我|你)?(?:跑|执行|测试|test|lint|诊断|排查|修|改|重启|发布|提交|push|commit|部署|归档|清理|生成图|生图|配图)/i,
  /(?:terminal|终端|shell|bash|命令|日志|进程|launchctl|git|ssh|rg|grep|npm|bun|node)/i,
];

const IMAGE_GENERATION_PATTERNS = [
  /(?:画图|生图|生成图片|生成一张|画一张|画一个|画一下|配图)/i,
  /(?:头像|自画像|插画|封面).*(?:画|生成|做|出|来|不要文字)/i,
  /(?:画|生成|做|出).*(?:头像|自画像|插画|封面|图片|图)/i,
];

function normalizeMode(value, fallback = TOOL_MODE_AUTO) {
  const mode = String(value || "").trim().toLowerCase();
  return [TOOL_MODE_AUTO, TOOL_MODE_CHAT, TOOL_MODE_FULL].includes(mode) ? mode : fallback;
}

export function stripToolModeDirective(message = "") {
  const text = String(message);
  const match = text.match(/^\s*\/(full|chat)\b[\s:：-]*/i);
  if (!match) {
    return { message: text, forcedMode: null };
  }
  return {
    message: text.slice(match[0].length).trimStart(),
    forcedMode: normalizeMode(match[1], null),
  };
}

export function inferToolMode(message = "") {
  return isImageGenerationRequest(message) || FULL_INTENT_PATTERNS.some((pattern) => pattern.test(message))
    ? TOOL_MODE_FULL
    : TOOL_MODE_CHAT;
}

export function isImageGenerationRequest(message = "") {
  return IMAGE_GENERATION_PATTERNS.some((pattern) => pattern.test(message));
}

export function resolveToolMode(message = "", env = process.env) {
  const stripped = stripToolModeDirective(message);
  if (stripped.forcedMode) {
    return { ...stripped, mode: stripped.forcedMode, source: "directive" };
  }

  const configured = normalizeMode(env.ETWIN_TOOL_MODE, TOOL_MODE_AUTO);
  if (configured !== TOOL_MODE_AUTO) {
    return { ...stripped, mode: configured, source: "env" };
  }

  return { ...stripped, mode: inferToolMode(stripped.message), source: "auto" };
}

export function normalizeToolMode(value) {
  return normalizeMode(value, TOOL_MODE_CHAT) === TOOL_MODE_FULL ? TOOL_MODE_FULL : TOOL_MODE_CHAT;
}
