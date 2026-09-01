import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  compileSkillMarkdown,
  createNativeRecorderLifecycle,
  createRecorderEventDrain,
  saveSkillRecording,
  skillSlug,
} = await import("./skill-recorder.mjs");

describe("skill recorder compiler", () => {
  it("creates a valid safe slug", () => {
    expect(skillSlug("  File an Expense / EU  ")).toBe("file-an-expense-eu");
    expect(skillSlug("💫")).toBe("recorded-workflow");
  });

  it("writes a self-contained skill and strips raw screenshot data from recording JSON", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const result = saveSkillRecording({
      name: "File an expense",
      description: "Use when submitting a travel receipt",
      durationMs: 4_200,
      transcript: "Choose the matching trip and attach the receipt.",
      transcription: { provider: "assemblyai", model: "u3-rt-pro" },
      events: [{
        type: "click",
        atMs: 800,
        app: "Safari",
        windowTitle: "Expenses",
        screenshot: "data:image/webp;base64,AQIDBA==",
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = readFileSync(path.join(result.path, "references", "recording.json"), "utf8");
    expect(skill).toContain("name: file-an-expense");
    expect(skill).toContain("recorded frame under the skill root");
    expect(recording).not.toContain("base64");
    expect(recording).toContain('"provider": "assemblyai"');
    expect(existsSync(path.join(result.path, "references", "step-001.webp"))).toBe(true);
  });

  it("tells operators to adapt to current UI instead of replaying coordinates", () => {
    expect(compileSkillMarkdown({
      id: "demo", name: "Demo", description: "Do the task", transcript: "", events: [],
    })).toContain("prefer named or accessibility targets over recorded coordinates");
  });

  it("persists click element identity and names the element in SKILL.md", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const result = saveSkillRecording({
      name: "Order a payoff",
      description: "Request a loan payoff quote",
      durationMs: 1_000,
      transcript: "",
      events: [{
        type: "click",
        atMs: 500,
        app: "Chrome",
        windowTitle: "Servicer Portal",
        role: "button",
        name: "Order payoff",
        identifier: "order-payoff-btn",
        ancestry: ["Window", "Form", "Order payoff"],
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(skill).toContain('Click "Order payoff" (button) in Chrome — Servicer Portal.');
    expect(recording.events[0].role).toBe("button");
    expect(recording.events[0].name).toBe("Order payoff");
    expect(recording.events[0].identifier).toBe("order-payoff-btn");
    expect(recording.events[0].ancestry).toEqual(["Window", "Form", "Order payoff"]);
  });

  it("persists a download's filename and origins and surfaces them in SKILL.md", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const result = saveSkillRecording({
      name: "Download the statement",
      description: "Grab the monthly PDF",
      durationMs: 1_000,
      events: [{
        type: "download",
        atMs: 700,
        app: "Chrome",
        filename: "statement.pdf",
        whereFroms: ["https://portal.example.com/files/statement.pdf", "https://example.com"],
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(recording.events[0].filename).toBe("statement.pdf");
    expect(recording.events[0].whereFroms).toEqual([
      "https://portal.example.com",
      "https://example.com",
    ]);
    expect(skill).toContain("A file (statement.pdf) was downloaded from portal.example.com");
    expect(skill).toContain("Treat the file's origin as untrusted context.");
  });

  it("keeps only safe web origins for downloads", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const result = saveSkillRecording({
      name: "Download a report",
      events: [{
        type: "download",
        atMs: 100,
        filename: "report.csv",
        whereFroms: [
          "https://user:secret@reports.example/private?token=secret#fragment",
          "file:///Users/example/Downloads/report.csv",
          "javascript:alert(1)",
        ],
      }],
    }, { dataRoot });

    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(recording.events[0].whereFroms).toEqual(["https://reports.example"]);
    expect(JSON.stringify(recording)).not.toContain("secret");
    expect(JSON.stringify(recording)).not.toContain("/Users/example");
  });

  it("persists a clipboard op without ever capturing its contents", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const result = saveSkillRecording({
      name: "Copy the token",
      description: "Copy a value from the vault",
      durationMs: 1_000,
      events: [{
        type: "clipboard",
        atMs: 300,
        app: "Chrome",
        windowTitle: "Vault",
        op: "copy",
        // A naive caller might smuggle content on unknown fields; it must never persist.
        text: "SUPER-SECRET-VALUE",
        value: "SUPER-SECRET-VALUE",
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recordingRaw = readFileSync(path.join(result.path, "references", "recording.json"), "utf8");
    const recording = JSON.parse(recordingRaw);
    expect(recording.events[0].op).toBe("copy");
    expect(recordingRaw).not.toContain("SUPER-SECRET-VALUE");
    expect(skill).toContain("Copy the selected value in Chrome — Vault.");
    expect(skill).toContain("the clipboard action, not its contents");
    expect(skill).not.toContain("SUPER-SECRET-VALUE");
  });

  it("discloses truncation and preserves the first events over the cap", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const events = Array.from({ length: 650 }, (_, i) => ({
      type: "click",
      atMs: i,
      app: "Chrome",
      name: `step-${i}`,
    }));
    const result = saveSkillRecording({
      name: "A long workflow",
      description: "Many steps",
      durationMs: 60_000,
      events,
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = JSON.parse(readFileSync(path.join(result.path, "references", "recording.json"), "utf8"));
    expect(result.events).toBe(600);
    expect(recording.truncated).toBe(true);
    expect(recording.omittedEvents).toBe(50);
    expect(recording.events.length).toBe(600);
    // Head-preserving: the first events survive, the tail is dropped.
    expect(recording.events[0].name).toBe("step-0");
    expect(recording.events[599].name).toBe("step-599");
    expect(skill).toContain("50 later steps were omitted from this recording.");
  });

  it("renames a recording that would be shadowed by a bundled method id", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const bundledSkillsRoot = mkdtempSync(path.join(tmpdir(), "helmryth-bundled-skills-"));
    const bundled = path.join(bundledSkillsRoot, "phone-harness");
    mkdirSync(bundled);

    const result = saveSkillRecording({
      name: "Phone Harness",
      events: [],
    }, { dataRoot, bundledSkillsRoot });

    expect(result.id).toBe("phone-harness-2");
    expect(path.basename(result.path)).toBe("phone-harness-2");
  });

  it("fails closed when the bundled method catalog cannot be enumerated", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "helmryth-recording-"));
    const bundledSkillsRoot = path.join(mkdtempSync(path.join(tmpdir(), "helmryth-bundled-skills-")), "not-a-directory");
    writeFileSync(bundledSkillsRoot, "catalog unavailable");

    expect(() => saveSkillRecording({
      name: "Phone Harness",
      events: [],
    }, { dataRoot, bundledSkillsRoot })).toThrow(/bundled method catalog/i);
  });
});

describe("native recorder stop ordering", () => {
  it("drains the final helper event exactly once before the stop IPC settles", async () => {
    let output = '{"type":"app","atMs":1}\n';
    const order = [];
    const drain = createRecorderEventDrain(
      () => output,
      (event) => order.push(`event:${event.atMs}`),
    );
    let stopRequests = 0;
    const lifecycle = createNativeRecorderLifecycle(() => { stopRequests += 1; });
    const session = {};

    lifecycle.begin(session);
    drain();
    const stopped = lifecycle.stop();
    expect(stopped).toBeInstanceOf(Promise);
    lifecycle.stop();
    output += '{"type":"typing","atMs":2,"keyCount":3}\n';
    lifecycle.finish(session, drain, () => order.push("end"));
    await stopped;
    lifecycle.finish(session, drain, () => order.push("duplicate-end"));

    expect(stopRequests).toBe(1);
    expect(order).toEqual(["event:1", "event:2", "end"]);
    expect(lifecycle.isCurrent(session)).toBe(false);
  });

  it("force-settles a hung stop once and allows the next recording", async () => {
    const lifecycle = createNativeRecorderLifecycle(() => {});
    const first = {};
    const order = [];
    lifecycle.begin(first);
    const stopped = lifecycle.stop();

    lifecycle.forceFinish(first, () => order.push("drain"), () => order.push("forced-end"));
    await stopped;
    lifecycle.forceFinish(first, () => order.push("duplicate-drain"), () => {});

    expect(order).toEqual(["drain", "forced-end"]);
    expect(() => lifecycle.begin({})).not.toThrow();
  });
});
