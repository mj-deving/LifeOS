import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  flowExercised,
  parseTurnEvents,
  pixelViewed,
  probedAfterDeploy,
} from "./transcript-evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function transcript(
  tools: Array<{ name: string; input: Record<string, unknown>; result?: string }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "lifeos-browser-evidence-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  const lines: string[] = [
    JSON.stringify({ message: { role: "user", content: [{ type: "text", text: "verify" }] } }),
  ];
  tools.forEach((tool, index) => {
    const id = `tool-${index}`;
    lines.push(JSON.stringify({
      message: { role: "assistant", content: [{ type: "tool_use", id, name: tool.name, input: tool.input }] },
    }));
    lines.push(JSON.stringify({
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: tool.result ?? "ok" }] },
    }));
  });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("GStack browser evidence", () => {
  test("classifies canonical browse commands", () => {
    const events = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse open https://example.com" } },
      { name: "Bash", input: { command: "browse click @e2" } },
      { name: "Bash", input: { command: "browse snapshot" } },
      { name: "Bash", input: { command: "browse screenshot --output /tmp/page.png" } },
    ]));
    expect(events.map((event) => event.kind)).toEqual([
      "gstack-nav",
      "gstack-interact",
      "gstack-observe",
      "gstack-capture",
    ]);
  });

  test("closes a same-owner exercised flow", () => {
    const events = parseTurnEvents(transcript([
      { name: "Edit", input: { file_path: "/tmp/App.tsx" } },
      { name: "Bash", input: { command: "browse open https://example.com" } },
      { name: "Bash", input: { command: "browse click @e2" } },
      { name: "Bash", input: { command: "browse snapshot" } },
    ]));
    expect(flowExercised(events)).toBe(true);
  });

  test("does not combine interaction and navigation from different owners", () => {
    const events = parseTurnEvents(transcript([
      { name: "Edit", input: { file_path: "/tmp/App.tsx" } },
      { name: "Bash", input: { command: "interceptor open https://example.com" } },
      { name: "Bash", input: { command: "browse click @e2" } },
    ]));
    expect(flowExercised(events)).toBe(false);
  });

  test("requires a post-action observation", () => {
    const events = parseTurnEvents(transcript([
      { name: "Edit", input: { file_path: "/tmp/App.tsx" } },
      { name: "Bash", input: { command: "browse open https://example.com" } },
      { name: "Bash", input: { command: "browse click @e2" } },
    ]));
    expect(flowExercised(events)).toBe(false);
  });

  test("keeps deploy verification on Interceptor while accepting viewed GStack pixels", () => {
    const events = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "bun run deploy" } },
      { name: "Bash", input: { command: "browse open https://example.com" } },
      { name: "Bash", input: { command: "browse screenshot --output /tmp/page.png" } },
      { name: "Read", input: { file_path: "/tmp/page.png" } },
    ]));
    expect(probedAfterDeploy(events, "example.com")).toBe(false);
    expect(pixelViewed(events)).toBe(true);

    const interceptorEvents = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "bun run deploy" } },
      { name: "Bash", input: { command: "interceptor open https://example.com" } },
    ]));
    expect(probedAfterDeploy(interceptorEvents, "example.com")).toBe(true);
  });

  test("does not classify browse text inside arguments or comments", () => {
    const events = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "echo 'browse open https://example.com'" } },
      { name: "Bash", input: { command: "rg 'browse screenshot' docs/" } },
      { name: "Bash", input: { command: "# browse click @e2" } },
      { name: "Bash", input: { command: "echo 'note; browse click @e2'" } },
    ]));
    expect(events.map((event) => event.kind)).toEqual(["command", "command", "command", "command"]);
  });

  test("emits every quote-safe compound browse event", () => {
    const events = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse click @e2 && browse snapshot && browse screenshot --output /tmp/result.png" } },
      { name: "Read", input: { file_path: "/tmp/result.png" } },
    ]));
    expect(events.map((event) => event.kind)).toEqual(["gstack-interact", "gstack-observe", "gstack-capture", "read-image"]);
    expect(flowExercised(events)).toBe(true);
    expect(pixelViewed(events)).toBe(true);
  });

  test("rejects compound evidence whose shell status can mask an earlier failure", () => {
    for (const command of [
      "browse click @missing; browse snapshot",
      "browse click @missing || browse snapshot",
      "browse click @missing | tee /tmp/browser.log",
      "browse click @missing & browse snapshot",
      "browse click @missing\nbrowse snapshot",
    ]) {
      const events = parseTurnEvents(transcript([{ name: "Bash", input: { command }, result: "ok" }]));
      expect(events.map((event) => event.kind)).toEqual(["command"]);
      expect(flowExercised(events)).toBe(false);
    }
  });

  test("requires same-context page state after the action", () => {
    const events = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "BROWSE_STATE_FILE=/tmp/a browse click @e2" } },
      { name: "Bash", input: { command: "BROWSE_STATE_FILE=/tmp/b browse snapshot" } },
      { name: "Bash", input: { command: "BROWSE_STATE_FILE=/tmp/a browse console" } },
    ]));
    expect(flowExercised(events)).toBe(false);
  });

  test("does not compose an action with state from a later page in the same context", () => {
    const events = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse open https://example.com" } },
      { name: "Bash", input: { command: "browse click @e2" } },
      { name: "Bash", input: { command: "browse open https://example.org" } },
      { name: "Bash", input: { command: "browse snapshot" } },
    ]));
    expect(flowExercised(events)).toBe(false);
  });

  test("does not compose across a same-origin navigation", () => {
    const events = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse open https://example.com/start" } },
      { name: "Bash", input: { command: "browse click @e2" } },
      { name: "Bash", input: { command: "browse open https://example.com/unrelated" } },
      { name: "Bash", input: { command: "browse snapshot" } },
    ]));
    expect(flowExercised(events)).toBe(false);
  });

  test("allows interleaved parallel contexts but invalidates a new same-context action", () => {
    const parallel = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "BROWSE_STATE_FILE=/tmp/a browse click @e2" } },
      { name: "Bash", input: { command: "BROWSE_STATE_FILE=/tmp/b browse snapshot" } },
      { name: "Bash", input: { command: "BROWSE_STATE_FILE=/tmp/a browse console" } },
      { name: "Bash", input: { command: "BROWSE_STATE_FILE=/tmp/a browse snapshot" } },
    ]));
    expect(flowExercised(parallel)).toBe(true);

    const superseded = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse click @e2" } },
      { name: "Bash", input: { command: "browse click @e3" } },
      { name: "Bash", input: { command: "browse snapshot" } },
    ]));
    expect(flowExercised(superseded)).toBe(true);
    expect(superseded.filter((event) => event.kind === "gstack-interact").length).toBe(2);
  });

  test("does not mistake a filled URL value for page navigation", () => {
    const gstack = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse open https://example.com/form" } },
      { name: "Bash", input: { command: "browse fill @website https://other.example" } },
      { name: "Bash", input: { command: "browse snapshot" } },
    ]));
    expect(flowExercised(gstack)).toBe(true);

    const interceptor = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "interceptor open https://example.com/form --context test" } },
      { name: "Bash", input: { command: "interceptor fill @website https://other.example --context test" } },
      { name: "Bash", input: { command: "interceptor read --context test" } },
    ]));
    expect(flowExercised(interceptor)).toBe(true);
  });

  test("requires reading the exact captured image after capture", () => {
    const events = parseTurnEvents(transcript([
      { name: "Read", input: { file_path: "/tmp/page.png" } },
      { name: "Bash", input: { command: "browse screenshot --output /tmp/page.png" } },
      { name: "Read", input: { file_path: "/tmp/unrelated.png" } },
    ]));
    expect(pixelViewed(events)).toBe(false);
  });

  test("normalizes relative and reported screenshot paths", () => {
    const relative = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse screenshot --output ./page.png" } },
      { name: "Read", input: { file_path: resolve("./page.png") } },
    ]));
    expect(pixelViewed(relative)).toBe(true);

    const reported = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse screenshot" }, result: "Screenshot saved to /tmp/default.png" },
      { name: "Read", input: { file_path: "/tmp/default.png" } },
    ]));
    expect(pixelViewed(reported)).toBe(true);

    const expanded = parseTurnEvents(transcript([
      { name: "Bash", input: { command: "browse screenshot --output \"$SHOT\"" }, result: "Screenshot saved to /tmp/expanded.png" },
      { name: "Read", input: { file_path: "/tmp/expanded.png" } },
    ]));
    expect(pixelViewed(expanded)).toBe(true);
  });
});
