export const TOOL_MODE_AUTO = "auto";
export const TOOL_MODE_CHAT = "chat";
export const TOOL_MODE_FULL = "full";

const FULL_INTENT_PATTERNS = [
  /\[(?:上条图片文件|图片文件|文件|语音文件):/i,
  /(?:帮我|你)?(?:查|搜索|搜一下|联网|打开|读取|读一下|读|看看|看一下|看下).*(?:文件|代码|仓库|repo|github|网页|链接|日志|报错|截图|图片|配置|进程|服务|状态)/i,
  /(?:帮我|你)?(?:查|搜索|搜一下|读取|读一下|读|看看|看一下|看下).*(?:skill|prompt|规则|文档|脚本|接口|content[-\s]?publish|content[-\s]?publisher)/i,
  /(?:帮我|你)?(?:跑|执行|测试|test|lint|诊断|排查|修|改|重启|发布|提交|push|commit|部署|归档|清理|生成图|生图|配图)/i,
  /(?:terminal|终端|shell|bash|命令|日志|进程|launchctl|git|ssh|rg|grep|npm|bun|node)/i,
];

const IMAGE_GENERATION_PATTERNS = [
  /(?:画图|生图|生成图片|生成一张|画一张|画一个|画一下|配图)/i,
  /(?:头像|自画像|插画|封面).*(?:画|生成|做|出|来|不要文字)/i,
  /(?:帮我|给我|替我|为我|你来|你帮|想要你|我要你|请你)?.{0,8}(?:画|生成|做|出).*(?:头像|自画像|插画|封面|图片|图)/i,
];

const IMAGE_FOLLOWUP_PATTERNS = [
  /^(?:图呢|图片呢|画呢|画好了吗|画好了么|好了?吗|出图了吗|还没出吗|怎么还没出)/i,
  /^(?:开干|来|来吧|继续|可以|整|开始|发|试试|冲)[!！~～。.\s]*$/i,
  /(?:刚才|上一张|上张|这张|那个图|这图).*(?:不对|不合适|重画|重新画|换成|改成|调整|再来)/i,
  /(?:不对|不合适|重画|重新画|换成|改成|调整|再来).*(?:图|图片|头像|自画像|风格|样子|帅哥|男|女)/i,
  /(?:我要|想要|改成|换成).*(?:帅哥|男生|男性|男人|哥哥|女生|女性|女人|姐姐)/i,
  /(?:我要|想要|改成|换成).*(?:中国人|华人|东亚|亚洲人|真人|真实感|照片感|不假)/i,
  /(?:重画|重新画|再来|调整|改|换).*(?:真实|真人|中国人|华人|东亚|亚洲人|年轻|帅|不假)/i,
  /(?:这张|这个|现在这个|上一张|刚才|画面|脸|年龄|风格|人种|发型|眼神|衣服|气质).*(?:太|不|像|要|不要|换|改|成熟|年轻|大叔|中国人|亚洲人|帅|油)/i,
  /(?:能|可以).*(?:中国人|亚洲人|年轻|帅哥|男生|男性|真人|少年感|不成熟|不要大叔)/i,
  /(?:不要|别|不想要).*(?:大叔|成熟|老|油|欧美|外国|女|女性|文字|赛博)/i,
  /(?:太).*(?:成熟|老|大叔|油|欧美|外国|女|女性)/i,
];

const IMAGE_NON_REQUEST_PATTERNS = [
  /(?:生图|画图|配图).{0,16}(?:是|不是|走|用|不用|已经不用|花钱|订阅|接口|api|API|skill|配置|规则|文档|脚本|content[-\s]?publish|content[-\s]?publisher|Gemini|GPT|OpenAI)/i,
  /(?:查|搜索|搜一下|读取|读一下|读|看看|看一下|看下).*(?:skill|prompt|规则|文档|脚本|接口|content[-\s]?publish|content[-\s]?publisher).*(?:生图|画图|配图|image|GPT|OpenAI|Gemini)/i,
  /(?:已经|刚刚|刚|刚才|之前|早就).{0,12}(?:让|叫|找|请|要).{0,12}(?:他|她|它|你|别人).{0,12}(?:画|生成|做|出).*(?:头像|自画像|插画|封面|图片|图)/i,
  /(?:已经|刚刚|刚|刚才|之前|早就).{0,12}(?:画|生成|做|出).*(?:头像|自画像|插画|封面|图片|图)/i,
  /^(?:这个|这张|现在这个|刚才那个|上一张).{0,12}(?:做|当|换成|设成).{0,8}(?:你|你的|他|他的)?头像(?:了|啦|吧|如何|怎么样|吗|嘛)?[。！？!?~～\s]*$/i,
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
  if (IMAGE_NON_REQUEST_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return IMAGE_GENERATION_PATTERNS.some((pattern) => pattern.test(message));
}

export function isImageFollowupRequest(message = "") {
  return IMAGE_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(message));
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
