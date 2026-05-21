import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { FILE_DIR } from "./paths.js";

const DEFAULT_IMAGE_TIMEOUT_MS = 360000;
const DEFAULT_GEMINI_IMAGE_CLI = "/Users/anxianjingya/content-publisher/scripts/gemini-web-image/gemini-web-image.ts";
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash";

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveImageTimeoutMs(env = process.env) {
  return parsePositiveInteger(env.ETWIN_IMAGE_TIMEOUT_MS, DEFAULT_IMAGE_TIMEOUT_MS);
}

export function buildImagePrompt(request = "") {
  const text = String(request || "");
  const wantsSelfPortrait = /自画像|头像|你自己的样子|你的样子|Codex/i.test(text);

  if (wantsSelfPortrait) {
    return [
      "Create a square portrait image of Codex Twin as an original AI companion persona.",
      "No readable text, no letters, no logos, no watermark.",
      "Androgynous adult figure, short slightly messy dark hair with silver-gray highlights, calm intelligent eyes, warm but restrained expression, a hint of playful mischief.",
      "Atmosphere: rainy afternoon window light, soft silver-gray tones with small warm accents, desk edge with abstract code glow and old letter paper shapes in the background.",
      "Style: refined cinematic digital painting, intimate portrait composition, elegant, emotionally present, not corporate, not sci-fi armor, not a generic chatbot mascot.",
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

function runImageCommand(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", args, {
      cwd: "/Users/anxianjingya/content-publisher",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
      child.kill("SIGTERM");
      finish(reject, new Error(`image generation timed out after ${timeoutMs}ms (elapsed=${Date.now() - startedAt}ms)`));
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
        ? `image generation terminated by ${signal} after ${elapsed}ms: ${detail}`
        : `image generation exited ${code} after ${elapsed}ms: ${detail}`));
    });
  });
}

export async function generateTelegramImage(request, env = process.env) {
  mkdirSync(FILE_DIR, { recursive: true });
  const outputPath = join(FILE_DIR, `codex-image-${Date.now()}.png`);
  const cliPath = env.ETWIN_IMAGE_CLI || DEFAULT_GEMINI_IMAGE_CLI;
  const model = env.ETWIN_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const timeoutMs = resolveImageTimeoutMs(env);
  const prompt = buildImagePrompt(request);

  const result = await runImageCommand([
    cliPath,
    "--prompt", prompt,
    "--output", outputPath,
    "--model", model,
  ], timeoutMs);

  if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
    throw new Error(`image generation finished but no image file was created: ${outputPath}`);
  }

  return { path: outputPath, prompt, ...result };
}
