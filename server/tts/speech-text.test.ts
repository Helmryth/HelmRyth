// The spoken register is the half of voice that decides whether it is
// pleasant, and it is the piece most likely to be tuned against real
// transcripts — so its behaviour is pinned here rather than discovered in
// the kitchen at 8am.
import { describe, expect, it } from "vitest";

import { narrateTool, speakable, toUtterances } from "./speech-text.ts";

describe("speakable", () => {
  it("names a code block instead of reading it", () => {
    const out = speakable("Here's the fix:\n\n```ts\nconst x: number = 1;\nif (x) throw new Error('no');\n```\n\nThat's it.");
    expect(out).toContain("TypeScript code block");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("throw");
    expect(out).toContain("That's it.");
  });

  it("closes an unterminated fence rather than swallowing the rest", () => {
    // a streamed reply can be mid-fence when we're asked to speak it
    const out = speakable("Working on it:\n\n```sh\nnpm test");
    expect(out).toContain("Working on it");
    expect(out).toContain("code block");
    expect(out).not.toContain("npm test");
  });

  it("keeps a link's words and drops its URL", () => {
    expect(speakable("See [the README](https://example.com/a/b?c=d) for more")).toBe(
      "See the README for more",
    );
  });

  it("turns a bare URL into a noun", () => {
    expect(speakable("Deployed to https://helmryth.example.com/status now")).toBe(
      "Deployed to a link now",
    );
  });

  it("says the file, not the path to it", () => {
    expect(speakable("I changed server/drivers/acp/core.ts today")).toBe("I changed core.ts today");
  });

  it("keeps short inline code but not long snippets", () => {
    expect(speakable("Run `pnpm test` first")).toBe("Run pnpm test first");
    const long = speakable(`Use \`${"x".repeat(60)}\` here`);
    expect(long).toBe("Use that snippet here");
  });

  it("strips list scaffolding but keeps the pause between items", () => {
    const out = speakable("- first thing\n- second thing\n- third thing");
    expect(out).toBe("first thing. second thing. third thing");
  });

  it("reads a table as rows, not pipes", () => {
    const out = speakable("| Name | State |\n| --- | --- |\n| Scout | idle |");
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
    expect(out).toContain("Scout, idle");
  });

  it("drops emphasis markers, emoji and checkboxes", () => {
    expect(speakable("**Done** ✅ — [x] shipped the _thing_")).toBe("Done — shipped the thing");
  });

  it("gives a heading a full stop so the voice breathes", () => {
    expect(speakable("## Results\nAll green")).toBe("Results. All green");
  });

  it("collapses the punctuation its own substitutions create", () => {
    expect(speakable("Done.\n\n\n- one\n\n- two")).toBe("Done. one. two");
  });

  it("is empty for empty input", () => {
    expect(speakable("")).toBe("");
    expect(speakable("   \n\n  ")).toBe("");
  });
});

describe("toUtterances", () => {
  it("splits on sentences", () => {
    const out = toUtterances("The tests pass now. I changed two files. Want me to push it?");
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("The tests pass now.");
    expect(out[2]).toBe("Want me to push it?");
  });

  it("does not split inside a decimal or an abbreviation", () => {
    const out = toUtterances("It dropped to 11.7 seconds per step, i.e. about half of what it was before.");
    expect(out).toHaveLength(1);
  });

  it("glues a fragment onto its neighbour", () => {
    // two words handed to a synthesizer produce two words of flat prosody
    const out = toUtterances("Yes. The whole suite is green and nothing else changed.");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Yes.");
  });

  it("breaks a runaway sentence at a clause, never mid-word", () => {
    const long = `I looked at ${Array.from({ length: 40 }, (_, i) => `item ${i}`).join(", ")} and finished.`;
    const out = toUtterances(long, { maxChars: 120 });
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(140);
    // nothing lost, nothing cut in half
    expect(out.join(" ")).toContain("item 39");
  });

  it("runs its input through the spoken register first", () => {
    const out = toUtterances("Fixed it.\n\n```js\nconsole.log(1)\n```\n\nShipped.");
    expect(out.join(" ")).not.toContain("console.log");
  });

  it("is empty for text that speaks to nothing", () => {
    expect(toUtterances("```\ncode only\n```")).not.toContain("code only");
    expect(toUtterances("")).toEqual([]);
  });
});

describe("narrateTool", () => {
  it("turns tool names into something worth hearing", () => {
    expect(narrateTool("Bash")).toBe("running a command");
    expect(narrateTool("Read")).toBe("reading a file");
    expect(narrateTool("Edit")).toBe("editing a file");
    expect(narrateTool("WebSearch")).toBe("searching the web");
    expect(narrateTool("screenshot")).toBe("looking at the screen");
  });

  it("sees through an MCP tool prefix", () => {
    expect(narrateTool("mcp__computer__click")).toBe("using the computer");
    expect(narrateTool("mcp__agents__ask_bot")).toBe("asking a teammate");
  });

  it("stays quiet for chips the user is already told about another way", () => {
    expect(narrateTool("auto-approved Bash:git (always allowed)")).toBeNull();
    expect(narrateTool("error: claude exited 1")).toBeNull();
    expect(narrateTool("")).toBeNull();
  });

  it("falls back to naming an unknown tool, without reading its argv", () => {
    expect(narrateTool("deploy_thing")).toBe("running deploy_thing");
    expect(narrateTool('curl -X POST "https://x/y" --data @{}')).toBeNull();
  });
});

// POST /api/tts/prepare runs this over arbitrary transcript text on the core's
// single event loop. The old path-shortening pattern nested a quantifier inside a
// repeated group, so a slash-free run of path characters backtracked quadratically:
// 32 KB took ~500 ms, and one in-cap 1 MB request held the whole core — every route
// and the SSE stream — for eight to ten minutes.
describe("path shortening cannot be made to backtrack", () => {
  const budgetMs = 250;

  it("stays fast on the input that used to freeze the core", () => {
    const evil = `${"a".repeat(64_000)}!`;
    const started = performance.now();
    speakable(evil);
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });

  it("stays fast when the run does contain separators", () => {
    const started = performance.now();
    speakable(`${"a/".repeat(32_000)}b`);
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });

  it("scales linearly rather than quadratically", () => {
    const run = (n: number) => {
      const text = `${"a".repeat(n)}!`;
      const started = performance.now();
      speakable(text);
      return performance.now() - started;
    };
    run(8_000); // warm
    const small = Math.max(run(8_000), 0.05);
    const large = Math.max(run(64_000), 0.05);
    // 8x the input must not cost anything like 64x the time
    expect(large / small).toBeLessThan(16);
  });

  it("still shortens real paths exactly as before", () => {
    expect(speakable("see a/b/c/file.ts now")).toContain("file.ts");
    expect(speakable("see a/b/c/file.ts now")).not.toContain("a/b/c");
    expect(speakable("src/components/Sidebar.tsx and pkg/x.json")).toContain("Sidebar.tsx");
    expect(speakable("no paths here")).toContain("no paths here");
  });
});

// The path-shortening fix above was not the only quadratic pattern in here. The
// table-separator strip had the same failure on a completely different input —
// plain whitespace — so the suite above passed while the core stayed killable.
// On a line holding no pipe, `^\s*\|?[\s:-]*\|...` had to surrender one
// character at a time so the required `\|` could be retried at every offset.
describe("table stripping cannot be made to backtrack", () => {
  const budgetMs = 250;

  it("stays fast on whitespace, the input that used to freeze the core", () => {
    // 2000 newlines through POST /api/tts/prepare measured ~1.9s on the core.
    const started = performance.now();
    speakable(" ".repeat(64_000));
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });

  it("stays fast on the pipe and dash characters the pattern is built from", () => {
    for (const filler of ["-", "|", ":", " |", "-|", " \t"]) {
      const started = performance.now();
      speakable(filler.repeat(32_000));
      expect(performance.now() - started, filler).toBeLessThan(budgetMs);
    }
  });

  it("scales linearly rather than quadratically", () => {
    const run = (n: number) => {
      const started = performance.now();
      speakable(" ".repeat(n));
      return performance.now() - started;
    };
    run(8_000); // warm
    const small = Math.max(run(8_000), 0.05);
    const large = Math.max(run(64_000), 0.05);
    expect(large / small).toBeLessThan(16);
  });

  it("still strips separator rows and keeps everything else", () => {
    const table = "| head | cols |\n|---|---|\n| one | two |";
    expect(speakable(table)).not.toContain("---");
    expect(speakable(table)).toContain("one");
    expect(speakable("| a | b |\n| :-- | --: |\n| 1 | 2 |")).not.toContain(":--");
    // A line that merely contains a pipe is not a separator row.
    expect(speakable("not a table | just a pipe")).toContain("just a pipe");
    // Whitespace-only text has no pipe, so nothing may be stripped from it.
    expect(speakable("   ")).toBe(speakable("   "));
  });
});
