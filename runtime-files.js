import { randomUUID } from "crypto";
import { basename, isAbsolute, relative, resolve, sep } from "path";

const MAX_INBOUND_FILENAME_BYTES = 120;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function takeUtf8Prefix(value, maxBytes) {
  let output = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) break;
    output += character;
    used += size;
  }
  return output;
}

function truncateFilename(value) {
  const extensionMatch = value.match(/(\.[A-Za-z0-9]{1,10})$/);
  const extension = extensionMatch?.[1] || "";
  const stem = extension ? value.slice(0, -extension.length) : value;
  const stemBudget = Math.max(1, MAX_INBOUND_FILENAME_BYTES - Buffer.byteLength(extension));
  return `${takeUtf8Prefix(stem, stemBudget)}${extension}`;
}

function normalizeStamp(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("File timestamp must be a non-negative safe integer");
  }
  return number;
}

function normalizeNonce(value) {
  const nonce = String(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) {
    throw new TypeError("File nonce must contain only letters, numbers, underscores, or hyphens");
  }
  return nonce;
}

function containedPath(rootDir, filename) {
  if (typeof rootDir !== "string" || !rootDir.trim()) {
    throw new TypeError("Runtime file root must be a non-empty path");
  }
  const root = resolve(rootDir);
  const target = resolve(root, filename);
  const child = relative(root, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Resolved runtime file path escaped its configured directory");
  }
  return target;
}

export function sanitizeInboundFilename(filename) {
  const leaf = basename(String(filename ?? "").normalize("NFKC").replaceAll("\\", "/"));
  let safe = leaf
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, "-")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

  if (!safe) safe = "file";
  if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`;
  return truncateFilename(safe);
}

export function createInboundFilePath(rootDir, filename, options = {}) {
  const stamp = normalizeStamp(options.now ?? Date.now());
  const nonce = normalizeNonce(options.nonce ?? randomUUID());
  const safeName = sanitizeInboundFilename(filename);
  return containedPath(rootDir, `${stamp}-${nonce}-${safeName}`);
}

export function createGeneratedFilePath(rootDir, prefix, extension, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(String(prefix))) {
    throw new TypeError("Generated file prefix is invalid");
  }
  if (!/^\.[A-Za-z0-9]{1,10}$/.test(String(extension))) {
    throw new TypeError("Generated file extension is invalid");
  }
  const stamp = normalizeStamp(options.now ?? Date.now());
  const nonce = normalizeNonce(options.nonce ?? randomUUID());
  return containedPath(rootDir, `${prefix}-${stamp}-${nonce}${extension}`);
}
