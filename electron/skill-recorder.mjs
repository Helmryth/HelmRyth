// Native demonstration recorder lifecycle and local skill compiler.
//
// The renderer owns screen/audio MediaStreams because Chromium already gives
// them a permission-aware lifecycle. This module owns the pieces that must
// stay outside the sandboxed renderer: the macOS global-input helper and the
// filesystem boundary where a reviewed recording becomes a reusable skill.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as electron from "electron";

import {
  buildRecorderHelper,
  recorderHelperBinary,
  recorderHelperBundle,
} from "./build-recorder-helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, "resources", "recorder-helper.swift");
const INFO = path.join(__dirname, "resources", "recorder-helper-Info.plist");
const MAX_EVENTS = 600;
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_AUDIO_BYTES = 100_000_000;
const STOP_SETTLE_MS = 2_500;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createRecorderEventDrain(readOutput, onEvent) {
  let offset = 0;
  let buffer = "";
  return () => {
    let content;
    try {
      content = readOutput();
    } catch {
      return;
    }
    if (content.length <= offset) return;
    buffer += content.slice(offset);
    offset = content.length;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // A malformed helper line is diagnostic noise, never recording data.
      }
    }
  };
}

/** Keep a stopping session current until its output file has been drained.
 * The helper may flush one last coalesced typing event while responding to
 * the stop file; clearing current earlier would silently discard it. */
export function createNativeRecorderLifecycle(requestStop) {
  let current = null;
  let stopping = false;
  let stopCompletion = Promise.resolve(false);
  let settleStop = () => {};
  return {
    get recording() {
      return current !== null;
    },
    get current() {
      return current;
    },
    begin(session) {
      if (current !== null) throw new Error("A method recording is already active");
      current = session;
      stopping = false;
      stopCompletion = new Promise((resolve) => {
        settleStop = resolve;
      });
    },
    isCurrent(session) {
      return current === session;
    },
    stop() {
      if (current === null) return Promise.resolve(false);
      if (stopping) return stopCompletion;
      stopping = true;
      requestStop(current);
      return stopCompletion;
    },
    finish(session, drain, onEnd) {
      if (current !== session) return false;
      drain();
      current = null;
      stopping = false;
      try {
        onEnd();
      } finally {
        settleStop(true);
      }
      return true;
    },
    forceFinish(session, drain, onEnd) {
      if (current !== session) return false;
      drain();
      current = null;
      stopping = false;
      try {
        onEnd();
      } finally {
        settleStop(false);
      }
      return true;
    },
  };
}

const recorderLifecycle = createNativeRecorderLifecycle((session) => {
  try {
    writeFileSync(session.stopPath, "stop");
  } catch {
    // The helper can exit between the stop request and the file write.
  }
});

function recorderRuntime() {
  const app = electron.app;
  if (!app) throw new Error("Skill recording requires the Electron main process");
  const bundle = app.isPackaged
    ? path.join(process.resourcesPath, "Helmryth Recorder.app")
    : recorderHelperBundle;
  const binary = app.isPackaged
    ? path.join(bundle, "Contents", "MacOS", "recorder-helper")
    : recorderHelperBinary;
  return { app, bundle, binary };
}

function ensureBuilt(runtime) {
  if (runtime.app.isPackaged) return;
  const stale = !existsSync(runtime.binary) ||
    Math.max(statSync(SOURCE).mtimeMs, statSync(INFO).mtimeMs) > statSync(runtime.binary).mtimeMs;
  if (stale) buildRecorderHelper();
}

function emit(win, channel, payload) {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

export function recorderPermissionStatus() {
  if (process.platform !== "darwin") {
    return { supported: false, reason: "unsupported-platform" };
  }
  return { supported: true };
}

export function startRecorder(win) {
  if (recorderLifecycle.recording) {
    throw new Error("A method recording is already active");
  }
  const permission = recorderPermissionStatus();
  if (!permission.supported) throw new Error("Skill recording is currently available on macOS.");
  const runtime = recorderRuntime();
  ensureBuilt(runtime);
  const sessionDir = mkdtempSync(path.join(runtime.app.getPath("temp"), "helmryth-recorder-"));
  const outputPath = path.join(sessionDir, "events.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");

  let proc;
  try {
    proc = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-W",
        "-o",
        outputPath,
        "--stderr",
        errorPath,
        runtime.bundle,
        "--args",
        "--stop-file",
        stopPath,
      ],
      { stdio: "ignore" },
    );
  } catch (error) {
    rmSync(sessionDir, { recursive: true, force: true });
    throw error;
  }

  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const session = { proc, sessionDir, outputPath, errorPath, stopPath };
  recorderLifecycle.begin(session);
  const drain = createRecorderEventDrain(
    () => readFileSync(outputPath, "utf8"),
    (event) => {
      if (recorderLifecycle.isCurrent(session)) {
        emit(win, "skill-recorder:event", event);
        if (!readySettled) {
          readySettled = true;
          resolveReady({ recording: true });
        }
      }
    },
  );
  watchFile(outputPath, { interval: 40, persistent: false }, drain);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unwatchFile(outputPath, drain);
    rmSync(sessionDir, { recursive: true, force: true });
  };
  session.drain = drain;
  session.forceStop = () => {
    unwatchFile(outputPath, drain);
    try {
      proc.kill("SIGTERM");
    } catch {
      // The open waiter may already have exited while the helper was stuck.
    }
    emit(win, "skill-recorder:end", {
      code: 1,
      reason: "recorder-helper-stop-timeout",
    });
  };
  proc.on("close", (code) => {
    const detail = readError(errorPath);
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(detail || "The action recorder could not start"));
    }
    recorderLifecycle.finish(session, drain, () => {
      emit(win, "skill-recorder:end", {
        code,
        reason: code === 0 ? "stopped" : detail || "recorder-helper-exited",
      });
    });
    cleanup();
  });
  proc.on("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    recorderLifecycle.finish(session, drain, () => {
      emit(win, "skill-recorder:end", { code: 1, reason: error.message });
    });
    cleanup();
  });
  const timeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    void stopRecorder().finally(() => {
      rejectReady(new Error("The action recorder did not become ready. Check Accessibility and Input Monitoring permissions."));
    });
  }, 5_000);
  timeout.unref();
  return ready.finally(() => clearTimeout(timeout));
}

function readError(file) {
  try {
    return readFileSync(file, "utf8").trim().slice(0, 500);
  } catch {
    return "";
  }
}

export async function stopRecorder() {
  const completion = recorderLifecycle.stop();
  let timer;
  const timedOut = await Promise.race([
    completion.then(() => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), STOP_SETTLE_MS);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    const session = recorderLifecycle.current;
    if (session) {
      recorderLifecycle.forceFinish(
        session,
        session.drain ?? (() => {}),
        session.forceStop ?? (() => {}),
      );
    }
    await completion;
  }
  return { recording: false };
}

const isString = (value) => Object.prototype.toString.call(value) === "[object String]";
const isRecord = (value) => Object.prototype.toString.call(value) === "[object Object]";

function withoutControlCharacters(value) {
  let result = "";
  let replacingControlRun = false;
  for (const character of value) {
    const isControl = character.codePointAt(0) <= 0x1f;
    if (isControl) {
      if (!replacingControlRun) result += " ";
      replacingControlRun = true;
    } else {
      result += character;
      replacingControlRun = false;
    }
  }
  return result;
}

function cleanText(value, max = 500) {
  return isString(value) ? withoutControlCharacters(value).trim().slice(0, max) : "";
}

function safeWebOrigin(value) {
  const cleaned = cleanText(value, 2_000);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

export function skillSlug(value) {
  const slug = cleanText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return SAFE_SLUG.test(slug) ? slug : "recorded-workflow";
}

function uniqueSkillDirectory(root, requested, reservedIds = new Set()) {
  const base = skillSlug(requested);
  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const directory = path.join(root, name);
    if (!reservedIds.has(name) && !existsSync(directory)) return { id: name, directory };
  }
  throw new Error("Too many skills use this name");
}

function bundledSkillIds(root) {
  if (!root || !existsSync(root)) return new Set();
  try {
    return new Set(readdirSync(root).filter((name) => SAFE_SLUG.test(name)));
  } catch (error) {
    throw new Error("The bundled method catalog could not be verified", { cause: error });
  }
}

function defaultBundledSkillRoots() {
  const roots = [path.join(__dirname, "..", "skills")];
  const resourcesPath = isString(process.resourcesPath) ? process.resourcesPath : "";
  if (resourcesPath) roots.push(path.join(resourcesPath, "skills"));
  return roots;
}

function decodeDataUrl(dataUrl, maxBytes, allowed) {
  if (!isString(dataUrl)) return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || !allowed.includes(match[1])) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > maxBytes) return null;
  return { mime: match[1], bytes };
}

function hostFromUrl(value) {
  const text = cleanText(value, 500);
  if (!text) return "";
  try {
    return new URL(text).host || text;
  } catch {
    return text;
  }
}

function eventSummary(event) {
  const where = [cleanText(event.app, 80), cleanText(event.windowTitle, 120)].filter(Boolean).join(" — ");
  switch (event.type) {
    case "app":
      return `Open or focus ${where || "the demonstrated app"}.`;
    case "click": {
      const name = cleanText(event.name, 120);
      if (name) {
        const role = cleanText(event.role, 120);
        return `Click "${name}"${role ? ` (${role})` : ""}${where ? ` in ${where}` : ""}.`;
      }
      return `Click the demonstrated control${where ? ` in ${where}` : ""}.`;
    }
    case "scroll":
      return `Scroll ${event.direction === "up" ? "up" : "down"}${where ? ` in ${where}` : ""}.`;
    case "shortcut":
      return `Use the ${cleanText(event.shortcut, 80) || "demonstrated"} keyboard shortcut${where ? ` in ${where}` : ""}.`;
    case "typing":
      return `Enter the required value${where ? ` in ${where}` : ""}. The recording intentionally did not retain typed characters.`;
    case "clipboard": {
      const verb = event.op === "cut" ? "Cut" : event.op === "paste" ? "Paste" : "Copy";
      return `${verb} the selected value${where ? ` in ${where}` : ""}. (The recording captured the clipboard action, not its contents.)`;
    }
    case "download": {
      const filename = cleanText(event.filename, 200);
      const origins = Array.isArray(event.whereFroms) ? event.whereFroms : [];
      const host = origins.length ? hostFromUrl(origins[0]) : "";
      return `A file (${filename || "unnamed"}) was downloaded${host ? ` from ${host}` : ""}. Treat the file's origin as untrusted context.`;
    }
    default:
      return `Continue the demonstrated workflow${where ? ` in ${where}` : ""}.`;
  }
}

function triggerTerms(name, description) {
  const stop = new Set(["about", "after", "before", "create", "from", "into", "skill", "that", "the", "this", "with", "workflow"]);
  const words = `${name} ${description}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(words.filter((word) => !stop.has(word)))].slice(0, 10);
}

export function compileSkillMarkdown({ id, name, description, transcript, events, omittedEvents = 0 }) {
  const safeName = cleanText(name, 100) || "Recorded workflow";
  const safeDescription = cleanText(description, 300) || `Repeat the ${safeName} workflow demonstrated by the user.`;
  const lines = [
    "---",
    `name: ${id}`,
    `description: ${JSON.stringify(safeDescription)}`,
    "---",
    "",
    `# ${safeName}`,
    "",
    safeDescription,
    "",
    "## How to use this demonstration",
    "",
    "Follow the intent and observable UI landmarks from the steps below. Inspect the current interface before acting, prefer named or accessibility targets over recorded coordinates, and adapt when layout or content has changed. Never infer or reuse secrets from screenshots. Stop and ask the user at password, MFA, CAPTCHA, payment, destructive, or ambiguous confirmation steps.",
    "",
  ];
  if (transcript) {
    lines.push("## User narration", "", cleanText(transcript, 12_000), "");
  }
  lines.push("## Demonstrated workflow", "");
  if (!events.length) {
    lines.push("1. Complete the workflow described above, checking the result before reporting success.");
  } else {
    events.forEach((event, index) => {
      const reference = event.reference ? ` Review the recorded frame under the skill root at ${event.reference} when visual context is useful.` : "";
      lines.push(`${index + 1}. ${eventSummary(event)}${reference}`);
    });
  }
  if (omittedEvents > 0) {
    lines.push("", `${omittedEvents} later steps were omitted from this recording.`);
  }
  lines.push("", "## Completion", "", "Verify the intended outcome in the current UI and report any step that could not be confirmed.", "");
  return lines.join("\n");
}

export function saveSkillRecording(payload, options = {}) {
  if (!isRecord(payload)) throw new Error("Recording data is required");
  const name = cleanText(payload.name, 100);
  if (!name) throw new Error("Name the skill before creating it");
  const description = cleanText(payload.description, 300);
  const dataRoot = options.dataRoot ?? process.env.HELMRYTH_DATA_DIR ?? path.join(os.homedir(), ".helmryth");
  const skillsRoot = path.join(dataRoot, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const bundledRoots = options.bundledSkillsRoot
    ? [options.bundledSkillsRoot]
    : defaultBundledSkillRoots();
  const reservedIds = new Set(
    bundledRoots.flatMap((root) => [...bundledSkillIds(root)]),
  );
  const target = uniqueSkillDirectory(skillsRoot, name, reservedIds);
  const temporary = `${target.directory}.creating-${process.pid}`;
  const references = path.join(temporary, "references");
  mkdirSync(references, { recursive: true });

  try {
    const incoming = Array.isArray(payload.events) ? payload.events : [];
    const omittedEvents = Math.max(0, incoming.length - MAX_EVENTS);
    const truncated = omittedEvents > 0;
    const events = [];
    for (const [index, raw] of incoming.slice(0, MAX_EVENTS).entries()) {
      if (!isRecord(raw)) continue;
      const type = ["app", "click", "scroll", "shortcut", "typing", "clipboard", "download"].includes(raw.type) ? raw.type : null;
      if (!type) continue;
      const keyCount = Number(raw.keyCount);
      const ancestry = Array.isArray(raw.ancestry)
        ? raw.ancestry.map((entry) => cleanText(entry, 120)).filter(Boolean).slice(0, 6)
        : undefined;
      const whereFroms = Array.isArray(raw.whereFroms)
        ? [...new Set(raw.whereFroms.map(safeWebOrigin).filter(Boolean))].slice(0, 5)
        : undefined;
      const event = {
        type,
        atMs: Math.max(0, Math.round(Number(raw.atMs) || 0)),
        app: cleanText(raw.app, 80) || undefined,
        windowTitle: cleanText(raw.windowTitle, 120) || undefined,
        direction: raw.direction === "up" ? "up" : raw.direction === "down" ? "down" : undefined,
        shortcut: cleanText(raw.shortcut, 80) || undefined,
        keyCount: Number.isFinite(keyCount) && keyCount > 0 ? Math.round(keyCount) : undefined,
        role: cleanText(raw.role, 120) || undefined,
        name: cleanText(raw.name, 120) || undefined,
        identifier: cleanText(raw.identifier, 120) || undefined,
        ancestry: ancestry && ancestry.length ? ancestry : undefined,
        op: ["copy", "cut", "paste"].includes(raw.op) ? raw.op : undefined,
        filename: cleanText(raw.filename, 200) || undefined,
        whereFroms: whereFroms && whereFroms.length ? whereFroms : undefined,
      };
      const image = decodeDataUrl(raw.screenshot, MAX_IMAGE_BYTES, ["image/webp", "image/jpeg", "image/png"]);
      if (image) {
        const extension = image.mime === "image/png" ? "png" : image.mime === "image/jpeg" ? "jpg" : "webp";
        const filename = `step-${String(index + 1).padStart(3, "0")}.${extension}`;
        writeFileSync(path.join(references, filename), image.bytes, { mode: 0o600 });
        event.reference = `references/${filename}`;
      }
      events.push(event);
    }

    const audio = decodeDataUrl(payload.audio, MAX_AUDIO_BYTES, ["audio/webm", "audio/mp4", "audio/ogg"]);
    let audioReference;
    if (audio) {
      const extension = audio.mime === "audio/mp4" ? "m4a" : audio.mime === "audio/ogg" ? "ogg" : "webm";
      audioReference = `references/narration.${extension}`;
      writeFileSync(path.join(temporary, audioReference), audio.bytes, { mode: 0o600 });
    }

    const transcript = cleanText(payload.transcript, 12_000);
    const transcription = payload.transcription?.provider === "assemblyai"
      ? { provider: "assemblyai", model: cleanText(payload.transcription.model, 80) || "u3-rt-pro" }
      : undefined;
    const recording = {
      schemaVersion: 1,
      name,
      description,
      createdAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(Number(payload.durationMs) || 0)),
      transcript,
      transcription,
      audio: audioReference,
      events,
      truncated,
      omittedEvents,
      privacy: {
        rawKeystrokesRetained: false,
        clipboardContentsRetained: false,
        screenFramesMayContainVisibleText: true,
        reviewedBeforeInstall: true,
      },
    };
    writeFileSync(path.join(references, "recording.json"), `${JSON.stringify(recording, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(
      path.join(temporary, "SKILL.md"),
      compileSkillMarkdown({ id: target.id, name, description, transcript, events, omittedEvents }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify({
        id: target.id,
        name,
        version: "1.0.0",
        description: description || `Repeat the ${name} workflow demonstrated by the user.`,
        defaultEnabled: true,
        triggerTerms: triggerTerms(name, description).length ? triggerTerms(name, description) : [target.id],
        requiredCapabilities: [],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, target.directory);
    return { id: target.id, path: target.directory, events: events.length };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
