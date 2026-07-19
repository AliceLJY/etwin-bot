import { existsSync, mkdirSync, statSync } from "fs";
import { spawn } from "child_process";
import { homedir, tmpdir } from "os";
import { isAbsolute, join } from "path";
import { FILE_DIR } from "./paths.js";
import { createGeneratedFilePath } from "./runtime-files.js";

const DEFAULT_IMAGE_TIMEOUT_MS = 600000;
const DEFAULT_IMAGE_PROVIDER = "codex-native";
const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-2.5-flash";
const DEFAULT_CODEX_IMAGE_MODEL = "gpt-5.5";
const DEFAULT_CODEX_IMAGE_REASONING_EFFORT = "low";
const DEFAULT_CODEX_IMAGE_SERVICE_TIER = "fast";

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveImageTimeoutMs(env = process.env) {
  return parsePositiveInteger(env.ETWIN_IMAGE_TIMEOUT_MS, DEFAULT_IMAGE_TIMEOUT_MS);
}

export function resolveImageProvider(env = process.env) {
  const provider = String(env.ETWIN_IMAGE_PROVIDER || DEFAULT_IMAGE_PROVIDER).trim().toLowerCase();
  return ["codex-native", "gemini"].includes(provider) ? provider : DEFAULT_IMAGE_PROVIDER;
}

export function resolveGeminiImageRuntime(env = process.env, home = homedir()) {
  const cwd = env.ETWIN_CONTENT_PUBLISHER_DIR || join(home, "content-publisher");
  const configuredCli = env.ETWIN_IMAGE_CLI || join(
    "scripts",
    "gemini-web-image",
    "gemini-web-image.ts",
  );
  const cliPath = isAbsolute(configuredCli) ? configuredCli : join(cwd, configuredCli);
  return { cwd, cliPath };
}

export function buildImagePrompt(request = "", env = process.env) {
  const text = String(request || "");
  const companionName = env.ETWIN_DISPLAY_NAME || (env.ETWIN_PERSONA === "cc" ? "CC Twin" : "Codex Twin");
  const wantsSelfPortrait = /自画像|头像|你自己的样子|你的样子|Codex/i.test(text);
  const wantsMasculine = /帅哥|男生|男性|男人|哥哥|男的|male|masculine/i.test(text);
  const wantsFeminine = !wantsMasculine && /女生|女性|女人|姐姐|女的|female|feminine/i.test(text);
  const wantsChinese = /中国人|华人|东亚|亚洲|Chinese|East Asian|Asian/i.test(text);
  const wantsRealistic = /真实|真人|电影|照片|质感|不像假|太假|动漫|插画|CG|render|photo|realistic|cinematic/i.test(text);
  const wantsYoung = /年轻|不要大叔|不成熟|少年感|二十|20|25|26|27|28|29|30/i.test(text);

  if (wantsSelfPortrait) {
    const ethnicity = wantsChinese || wantsRealistic
      ? "Chinese / East Asian facial features, modern Chinese urban temperament"
      : "subtle East Asian or ethnically ambiguous facial features";
    const age = wantsYoung ? "25 to 30 years old, clearly not middle-aged" : "late 20s to early 30s";
    const subjectLine = wantsMasculine
      ? `Photorealistic handsome Chinese man, ${age}, ${ethnicity}, short slightly messy dark hair with a few silver-gray highlights, clean face, natural skin texture, calm intelligent eyes, warm but restrained expression, a hint of playful mischief.`
      : wantsFeminine
        ? `Photorealistic handsome Chinese woman, ${age}, ${ethnicity}, short slightly messy dark hair with a few silver-gray highlights, clean face, natural skin texture, calm intelligent eyes, warm but restrained expression, a hint of playful mischief.`
        : `Photorealistic androgynous Chinese / East Asian adult, ${age}, short slightly messy dark hair with a few silver-gray highlights, clean face, natural skin texture, calm intelligent eyes, warm but restrained expression, a hint of playful mischief.`;
    return [
      `Create a square portrait photo of ${companionName} as an original AI companion persona.`,
      "No readable text, no letters, no logos, no watermark, no UI text, no fake writing.",
      subjectLine,
      "Style: realistic cinematic photograph, like a still from a modern Chinese indie film, 35mm lens, natural window light, shallow depth of field, real skin pores and slight facial asymmetry, not airbrushed.",
      "Atmosphere: rainy afternoon window light, quiet desk, a laptop edge and paper shapes in soft blur only, no readable code or handwriting.",
      "Avoid: anime, manga, illustration, digital painting, CGI, 3D render, game character, fantasy, idol poster, overly perfect model face, western features, mature uncle, beard-heavy look, greasy CEO style, sci-fi armor, chatbot mascot.",
      `User request: ${text}`,
    ].join("\n");
  }

  return [
    "Create one polished image for the user request below.",
    "No readable text, no letters, no logos, no watermark unless the user explicitly asked for text.",
    "Style should be visually clear, refined, and emotionally specific rather than stock-like.",
    `User request: ${text}`,
  ].join("\n");
}

export function buildCodexImageWorkerPrompt(prompt, outputPath) {
  return [
    "You are the image generation worker for Alice's Telegram Codex Twin.",
    "This is a narrow non-interactive worker task. Do not inspect project files, do not read AGENTS.md, and do not load extra skill docs.",
    "",
    "Use the built-in Codex image_gen tool to create exactly one PNG image.",
    "Do not use Gemini, gemini-web-image, external image websites, API keys, or paid image APIs.",
    "After image_gen finishes, locate the generated PNG under ~/.codex/generated_images and copy it to this exact target path:",
    outputPath,
    "",
    "Hard requirements:",
    "- Final file must be a PNG and must exist at the target path.",
    "- Do not modify files except creating or replacing that target image path.",
    "- No readable text, letters, logos, UI text, or watermark in the image unless explicitly requested.",
    "- Prefer photorealistic, natural, Chinese / East Asian facial features when the request asks for a person, Chinese person, realism, or a self portrait.",
    "",
    "Image prompt:",
    prompt,
    "",
    "After saving, verify the target file exists and has size > 0.",
    `Reply exactly: SUCCESS: path=${outputPath} size=<bytes> tool=image_gen`,
    "If built-in image_gen is unavailable, reply exactly: FAILED: image_gen unavailable",
  ].join("\n");
}

function runCommand(command, args, { cwd, env, stdin, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (_) {
        child.kill("SIGTERM");
      }
      finish(reject, new Error(`${label} timed out after ${timeoutMs}ms (elapsed=${Date.now() - startedAt}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code, signal) => {
      const elapsed = Date.now() - startedAt;
      if (code === 0) {
        finish(resolve, { stdout, stderr, elapsed });
        return;
      }
      const detail = stderr.slice(-1200) || stdout.slice(-1200);
      finish(reject, new Error(signal
        ? `${label} terminated by ${signal} after ${elapsed}ms: ${detail}`
        : `${label} exited ${code} after ${elapsed}ms: ${detail}`));
    });

    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function runGeminiImageCommand(prompt, outputPath, env, timeoutMs) {
  const { cwd, cliPath } = resolveGeminiImageRuntime(env);
  const model = env.ETWIN_IMAGE_MODEL || DEFAULT_GEMINI_IMAGE_MODEL;
  return runCommand("bun", [
    cliPath,
    "--prompt", prompt,
    "--output", outputPath,
    "--model", model,
  ], {
    cwd,
    env,
    timeoutMs,
    label: "gemini image generation",
  });
}

function resolveCodexImageServiceTier(env) {
  const value = String(env.ETWIN_IMAGE_CODEX_SERVICE_TIER || env.ETWIN_CODEX_SERVICE_TIER || DEFAULT_CODEX_IMAGE_SERVICE_TIER).toLowerCase();
  return ["fast", "flex"].includes(value) ? value : "";
}

function resolveCodexImageReasoningEffort(env) {
  const value = String(env.ETWIN_IMAGE_CODEX_REASONING_EFFORT || DEFAULT_CODEX_IMAGE_REASONING_EFFORT).toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(value) ? value : DEFAULT_CODEX_IMAGE_REASONING_EFFORT;
}

function resolveCodexImageSandbox(env) {
  const value = env.ETWIN_IMAGE_CODEX_SANDBOX || "workspace-write";
  return ["read-only", "workspace-write", "danger-full-access"].includes(value) ? value : "workspace-write";
}

function runCodexNativeImageCommand(prompt, outputPath, env, timeoutMs) {
  const lastMessagePath = createGeneratedFilePath(FILE_DIR, "codex-image-worker", ".txt");
  const model = env.ETWIN_IMAGE_CODEX_MODEL || env.ETWIN_CODEX_MODEL || env.CODEX_MODEL || DEFAULT_CODEX_IMAGE_MODEL;
  const reasoningEffort = resolveCodexImageReasoningEffort(env);
  const serviceTier = resolveCodexImageServiceTier(env);
  const sandbox = resolveCodexImageSandbox(env);
  const args = [
    "exec",
    "--ignore-user-config",
    "--enable", "image_generation",
    "--cd", tmpdir(),
    "--add-dir", FILE_DIR,
    "--skip-git-repo-check",
    "--sandbox", sandbox,
    "--ignore-rules",
    "-c", "approval_policy=\"never\"",
    "-c", `model_reasoning_effort="${reasoningEffort}"`,
    "-o", lastMessagePath,
  ];

  if (serviceTier) {
    args.push("-c", `service_tier="${serviceTier}"`);
  }
  if (model) {
    args.push("--model", model);
  }
  args.push("-");

  return runCommand("codex", args, {
    cwd: tmpdir(),
    env,
    stdin: buildCodexImageWorkerPrompt(prompt, outputPath),
    timeoutMs,
    label: "codex native image generation",
  });
}

export async function generateTelegramImage(request, env = process.env) {
  mkdirSync(FILE_DIR, { recursive: true });
  const outputPath = createGeneratedFilePath(FILE_DIR, "codex-image", ".png");
  const timeoutMs = resolveImageTimeoutMs(env);
  const prompt = buildImagePrompt(request, env);
  const provider = resolveImageProvider(env);

  const result = provider === "gemini"
    ? await runGeminiImageCommand(prompt, outputPath, env, timeoutMs)
    : await runCodexNativeImageCommand(prompt, outputPath, env, timeoutMs);

  if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
    throw new Error(`${provider} image generation finished but no image file was created: ${outputPath}`);
  }

  return { path: outputPath, prompt, provider, ...result };
}
