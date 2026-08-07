/**
 * transcript-evidence.ts — ground-truth evidence extraction for VerificationGate.
 *
 * The message is a CLAIM; the transcript is the EVIDENCE. This module parses the
 * current turn's tool_use/tool_result entries from a Claude Code transcript JSONL
 * into an ordered event index, then answers "did the required verification
 * actually run, after the last mutation, and succeed?" — so a message that SAYS
 * "interceptor-verified" but whose transcript shows only a render capture cannot
 * pass, and a terse message that cites nothing but whose transcript shows a real
 * round-trip does.
 *
 * Design: Fable + Forge synthesis (2026-07-08). Fail-OPEN on every ambiguity —
 * this module must never be the reason a Stop is blocked.
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

export type EventKind =
  | "edit"              // Edit/Write/NotebookEdit
  | "deploy"            // wrangler/pages deploy, bun run deploy
  | "probe"             // curl/http/WebFetch to a URL
  | "interceptor-nav"   // interceptor open|navigate|goto
  | "interceptor-interact" // interceptor click|type|fill|act|eval|submit
  | "interceptor-observe" // interceptor read|text|tree|state|diff|eval
  | "interceptor-capture"  // interceptor screenshot|capture|scrub
  | "gstack-nav"        // browse open|goto|navigate
  | "gstack-interact"   // browse click|fill|type|press|select|hover|drag|upload|check
  | "gstack-observe"    // browse snapshot|text|url|eval|exists|count
  | "gstack-diagnostic" // browse console|network (not page-state evidence)
  | "gstack-capture"    // browse screenshot
  | "test-run"          // bun test / pytest / go test / vitest / npm test
  | "command"           // any other Bash command (fallback — carries its result/error)
  | "read-image"        // Read of a .png/.webp/.jpg (the model actually views it)
  | "agent-result"      // Agent/Task result text
  | "user-text";        // a user message (for userConfirmed / turn boundary)

export interface TxEvent {
  seq: number;
  kind: EventKind;
  tool: string;
  /** File path, URL host, or command excerpt — kind-specific. */
  target: string;
  /** Raw text of the paired tool_result (or the user text). */
  resultText: string;
  /** True when the tool_result was an error or the result text signals failure. */
  isError: boolean;
  /** Doc-only edits (.md / MEMORY / ISA) don't count as code mutations. */
  isCode: boolean;
  /** Browser state owner. Only same-context action/observation pairs compose. */
  context?: string;
  /** Exact screenshot output path, when the command declares one. */
  artifact?: string;
}

const CAP_BYTES = 8 * 1024 * 1024;

function safeRead(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    // Read only the tail if huge — recent events are what matter.
    if (buf.length > CAP_BYTES) return buf.subarray(buf.length - CAP_BYTES).toString("utf-8");
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

function eTLD1(host: string): string {
  const parts = host.replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!.split(".");
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

function extractHost(cmd: string): string {
  const m = cmd.match(/https?:\/\/([^\s"'/]+)/i);
  return m ? eTLD1(m[1]!) : "";
}

const DEPLOY_RE = /\b(wrangler(@\S+)?\s+(pages\s+)?deploy|bun\s+run\s+deploy|pages\s+deploy)\b/i;
const TEST_RE = /\b(bun\s+test|pytest|go\s+test|cargo\s+test|vitest|npm\s+(run\s+)?test|jest|deno\s+test)\b/i;
const INTERCEPTOR_RE = /\binterceptor\b|Capture\.sh|Interceptor\/Tools/i;
const NAV_RE = /\b(open|navigate|goto)\b/i;
const INTERACT_RE = /\b(click|type|fill|submit|act\b|keys)\b/i; // NOT eval — eval is a read, not an interaction (FN-A)
const OBSERVE_RE = /\b(read|text|tree|state|diff|eval|exists|count)\b/i;
const CAPTURE_RE = /\b(screenshot|capture|scrub)\b/i;
const GSTACK_COMMAND_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]+))\s+)*(?:(?:\S*\/)?browse)\s+(open|goto|navigate|click|fill|type|press|select|hover|drag|upload|check|uncheck|screenshot|snapshot|text|url|eval|exists|count|console|network)\b/i;
const PROBE_RE = /\bcurl\b|\bhttpie\b/i; // not bare "http" — dodges `http.server` etc.
const IMG_RE = /\.(png|jpe?g|webp)\b/i;
// Narrow: an HTTP 4xx/5xx STATUS LINE, or explicit failure words — NOT a bare
// "500" (which matches "500.42 KiB" in normal wrangler output → FP-A) and not
// a bare "error"/"failed" (common in success/deprecation text).
const ERROR_MARKERS = /\bHTTP[/ ]?\d(\.\d)?\s+[45]\d\d\b|\b(internal server error|traceback|connection refused|timed out|command not found|permission denied)\b|"?is_error"?\s*[:=]\s*true|\bexit\s+(code\s+)?[1-9]\d*\b/i;
// A real HTTP success (2xx/3xx) status line or session marker — not a bare
// number like "250 records" (FN-C).
const HTTP_SUCCESS = /\bHTTP[/ ]?\d(\.\d)?\s+[23]\d\d\b|set-cookie|location:\s*\//i;

function splitShellCommands(command: string): string[] {
  const commands: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    const value = current.trim();
    if (value) commands.push(value);
    current = "";
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === "\n" || char === ";" || (char === "&" && command[i + 1] === "&") || (char === "|" && command[i + 1] === "|")) {
      flush();
      if (char === "&" || char === "|") i++;
      continue;
    }
    current += char;
  }
  flush();
  return commands;
}

function hasUnsafeBrowserSeparator(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";" || char === "\n") return true;
    if (char === "|" || (char === "&" && command[i + 1] !== "&")) return true;
    if (char === "&" && command[i + 1] === "&") i++;
  }
  return false;
}

function optionValue(command: string, names: string[]): string {
  const alternation = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return command.match(new RegExp(`(?:${alternation})(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`))?.slice(1).find(Boolean) ?? "";
}

function browserContext(command: string, owner: "gstack" | "interceptor"): string {
  if (owner === "gstack") {
    const stateFile = command.match(/\bBROWSE_STATE_FILE=(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.slice(1).find(Boolean) ?? "default";
    return `gstack:${stateFile}`;
  }
  const context = optionValue(command, ["--context"]) || "default";
  const group = optionValue(command, ["--group"]) || "default";
  return `interceptor:${context}:${group}`;
}

function normalizeArtifact(path: string): string {
  if (!path) return "";
  return resolve(path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path);
}

function captureArtifact(command: string, resultText = ""): string {
  const declared = optionValue(command, ["--output", "--out"]);
  const reported = resultText.match(/(?:^|\s)((?:~\/|\.\.?\/|\/)[^\s"'`]+\.(?:png|jpe?g|webp))\b/i)?.[1] ?? "";
  return normalizeArtifact(/[$`]/.test(declared) ? reported : declared || reported);
}

interface BrowserEventSeed {
  kind: EventKind;
  target: string;
  context: string;
  artifact?: string;
}

function gstackEvents(command: string): BrowserEventSeed[] {
  if (hasUnsafeBrowserSeparator(command)) return [];
  const events: BrowserEventSeed[] = [];
  for (const segment of splitShellCommands(command)) {
    if (segment.startsWith("#")) continue;
    const verb = segment.match(GSTACK_COMMAND_RE)?.[1]?.toLowerCase();
    if (!verb) continue;
    let kind: EventKind = "gstack-observe";
    if (verb === "screenshot") kind = "gstack-capture";
    else if (/^(open|goto|navigate)$/.test(verb)) kind = "gstack-nav";
    else if (/^(click|fill|type|press|select|hover|drag|upload|check|uncheck)$/.test(verb)) kind = "gstack-interact";
    else if (/^(console|network)$/.test(verb)) kind = "gstack-diagnostic";
    events.push({
      kind,
      target: kind === "gstack-nav" ? extractHost(segment) : "",
      context: browserContext(segment, "gstack"),
      artifact: kind === "gstack-capture" ? captureArtifact(segment) : undefined,
    });
  }
  return events;
}

/** True when result text signals a test actually passed (n>0 pass, 0 fail / exit 0). */
export function testResultPassed(text: string): boolean {
  if (/\b(\d+)\s+fail(ed|ing|ures?)?\b/i.test(text)) {
    const f = text.match(/\b(\d+)\s+fail/i);
    if (f && Number(f[1]) > 0) return false;
  }
  if (/\b0\s+pass\b/i.test(text)) return false;
  return /\b([1-9]\d*)\s+pass\b/i.test(text) || /\bexit(\s+code)?\s+0\b/i.test(text) || /\ball\s+(tests?\s+)?(pass|green)/i.test(text);
}

interface RawEntry { type?: string; role?: string; message?: any; content?: any; toolUseResult?: any; }

/**
 * Parse the CURRENT TURN (everything after the last user/human message) into an
 * ordered event list. Returns [] on any read/parse failure (caller fails open).
 */
export function parseTurnEvents(
  transcriptPath: string,
  opts?: { sessionWindow?: boolean },
): TxEvent[] {
  const raw = safeRead(transcriptPath);
  if (!raw) return [];

  const lines = raw.split("\n");
  // Map tool_use_id -> {text, isError} from tool_result blocks (they live in
  // subsequent user-role entries).
  const results = new Map<string, { text: string; isError: boolean }>();
  const parsed: { i: number; entry: RawEntry }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || (!line.includes("tool_use") && !line.includes("tool_result") && !line.includes('"user"') && !line.includes('"human"'))) continue;
    let entry: RawEntry;
    try { entry = JSON.parse(line) as RawEntry; } catch { continue; }
    parsed.push({ i, entry });
    const content = entry.message?.content ?? entry.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_result" && b.tool_use_id) {
          const text = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join(" ") : "";
          results.set(b.tool_use_id, { text: String(text).slice(0, 4000), isError: b.is_error === true });
        }
      }
    }
  }

  // Turn boundary: last user/human message that is NOT purely a tool_result carrier.
  // `sessionWindow` keeps turnStart at 0 so the whole transcript counts as evidence.
  // Needed by VerificationGate's T5: a probe of the public repo three turns ago is
  // real evidence for a publicity claim now, and turn-scoping it would block honest
  // multi-turn work. The 8MB tail cap in safeRead already bounds the scan.
  let turnStart = 0;
  if (!opts?.sessionWindow) {
    for (let k = parsed.length - 1; k >= 0; k--) {
      const e = parsed[k]!.entry;
      const role = e.role ?? e.message?.role ?? e.type;
      if (role === "user" || role === "human") {
        const content = e.message?.content ?? e.content;
        const isToolResultOnly = Array.isArray(content) && content.every((b: any) => b?.type === "tool_result");
        const hasText = typeof content === "string" ? content.trim().length > 0
          : Array.isArray(content) && content.some((b: any) => b?.type === "text" && b.text?.trim());
        if (!isToolResultOnly && hasText) { turnStart = k; break; }
      }
    }
  }

  const events: TxEvent[] = [];
  const browserHosts = new Map<string, string>();
  let seq = 0;
  for (let k = turnStart; k < parsed.length; k++) {
    const e = parsed[k]!.entry;
    const content = e.message?.content ?? e.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      const name = String(b.name ?? "");
      const input = b.input ?? {};
      const res = b.id ? results.get(b.id) : undefined;
      const resultText = res?.text ?? "";
      const isErrorFlag = res?.isError === true || (resultText ? ERROR_MARKERS.test(resultText) : false);
      const push = (kind: EventKind, target: string, isCode = false, context?: string, artifact?: string) =>
        events.push({ seq: seq++, kind, tool: name, target, resultText, isError: isErrorFlag, isCode, context, artifact });

      if (name === "Edit" || name === "Write" || name === "NotebookEdit") {
        const p = String(input.file_path ?? input.notebook_path ?? "");
        const isCode = !!p && !/\.(md|markdown|txt)$|\/MEMORY\/|\/ISA\.md$|ISA\.md$/i.test(p);
        push("edit", p, isCode);
      } else if (name === "Bash") {
        const cmd = String(input.command ?? "");
        const gstack = gstackEvents(cmd);
        if (DEPLOY_RE.test(cmd)) push("deploy", extractHost(cmd));
        else if (INTERCEPTOR_RE.test(cmd)) {
          const context = browserContext(cmd, "interceptor");
          // Capture-first: a `screenshot --type full` must read as a capture, not
          // an interaction; a capture saved to `navigate.png` must not read as nav.
          const isCapture = CAPTURE_RE.test(cmd);
          const isInteraction = !isCapture && INTERACT_RE.test(cmd);
          const isNavigation = !isCapture && !isInteraction && NAV_RE.test(cmd);
          const host = isNavigation ? extractHost(cmd) : "";
          if (host) browserHosts.set(context, host);
          const target = host || browserHosts.get(context) || "";
          if (isCapture) push("interceptor-capture", target, false, context, captureArtifact(cmd, resultText));
          else if (isInteraction) push("interceptor-interact", target, false, context);
          else if (isNavigation) push("interceptor-nav", target, false, context);
          else if (OBSERVE_RE.test(cmd)) push("interceptor-observe", target, false, context);
          else push("interceptor-nav", target, false, context);
        } else if (gstack.length > 0) {
          // GStack's canonical `browse` CLI is Playwright-backed browser evidence.
          for (const event of gstack) {
            if (event.target && event.kind === "gstack-nav") browserHosts.set(event.context, event.target);
            const target = event.target || browserHosts.get(event.context) || "";
            const artifact = event.kind === "gstack-capture" ? event.artifact || captureArtifact("", resultText) : event.artifact;
            push(event.kind, target, false, event.context, artifact);
          }
        } else if (TEST_RE.test(cmd) && !/--dry-run/.test(cmd)) push("test-run", cmd.slice(0, 120));
        else if (PROBE_RE.test(cmd)) push("probe", extractHost(cmd));
        else push("command", cmd.slice(0, 120)); // fallback: a plain command's failure must still be visible evidence
      } else if (name === "WebFetch") {
        push("probe", eTLD1(String(input.url ?? "")));
      } else if (name === "Read") {
        const p = String(input.file_path ?? "");
        if (IMG_RE.test(p)) push("read-image", normalizeArtifact(p));
      } else if (name === "Agent" || name === "Task") {
        push("agent-result", String(input.description ?? name));
      }
    }
  }
  return events;
}

// ── Query API — everything the hook needs, all fail-open (absent ⇒ "no evidence"
// which only ever contributes to a PASS via the act-then-claim precondition). ──

export function lastCodeMutationSeq(ev: TxEvent[]): number {
  let s = -1;
  for (const e of ev) if ((e.kind === "edit" && e.isCode) || e.kind === "deploy") s = Math.max(s, e.seq);
  return s;
}
export function hadDeploy(ev: TxEvent[]): boolean { return ev.some((e) => e.kind === "deploy"); }
export function hadCodeEdit(ev: TxEvent[]): boolean { return ev.some((e) => e.kind === "edit" && e.isCode); }
export function hadFrontendEdit(ev: TxEvent[]): boolean {
  return ev.some((e) => e.kind === "edit" && /\.(tsx|jsx|vue|svelte|css|html|astro|png|svg|webp)$/i.test(e.target));
}
export function spawnedAgent(ev: TxEvent[]): boolean { return ev.some((e) => e.kind === "agent-result"); }
/** Edits to auth/flow-adjacent files — lets a terse "verified" claim be typed as
 * a flow claim (T2) from what the session actually TOUCHED, not just its wording. */
export function hadFlowEdit(ev: TxEvent[]): boolean {
  return ev.some((e) => e.kind === "edit" && e.isCode && /(auth|login|oauth|sign[\s-]?in|callback|session|checkout|payment)/i.test(e.target));
}

/** A post-deploy probe (curl 2xx/3xx OR interceptor nav) of the claimed host. */
export function probedAfterDeploy(ev: TxEvent[], host?: string): boolean {
  // Anchor on the deploy's EXISTENCE (its stdout may carry error-ish text); the
  // probe's success is what matters. Use the LAST deploy (Math.max) so a
  // re-deploy after a probe isn't credited by the earlier probe (FN-D).
  const dep = ev.filter((e) => e.kind === "deploy").map((e) => e.seq);
  if (dep.length === 0) return false;
  const after = Math.max(...dep);
  return ev.some(
    (e) => e.seq > after && !e.isError &&
      (e.kind === "probe" || e.kind === "interceptor-nav" || e.kind === "interceptor-capture") &&
      (!host || !e.target || eTLD1(host) === e.target),
  );
}

/**
 * The flow was EXERCISED (not just rendered). Requires, after the last mutation:
 *  (a) an Interceptor or GStack interaction followed by that same owner's state observation, OR
 *  (b) a probe/round-trip whose result shows a success marker (2xx/3xx, Set-Cookie,
 *      redirect to an app path) and is NOT an error.
 * A lone capture is a render, never flow evidence — this is the Apple-500 catch.
 */
export function flowExercised(ev: TxEvent[]): boolean {
  const after = lastCodeMutationSeq(ev);
  const post = ev.filter((e) => e.seq > after);
  const completed = (
    interactionKind: "interceptor-interact" | "gstack-interact",
    observationKind: "interceptor-observe" | "gstack-observe",
  ) => post.some((action, index) => {
    if (action.kind !== interactionKind || action.isError) return false;
    const owner = interactionKind.startsWith("gstack") ? "gstack-" : "interceptor-";
    for (const observation of post.slice(index + 1)) {
      if (!observation.kind.startsWith(owner) || observation.context !== action.context) continue;
      if (observation.kind.endsWith("-nav") || observation.kind.endsWith("-interact")) return false;
      if (observation.kind !== observationKind || observation.isError) continue;
      if (action.target && observation.target && action.target !== observation.target) continue;
      return observation.resultText.trim().length > 0;
    }
    return false;
  });
  if (completed("interceptor-interact", "interceptor-observe") || completed("gstack-interact", "gstack-observe")) return true;
  // A round-trip needs a real HTTP 2xx/3xx status line or a session marker —
  // not a bare number like "250 records" (FN-C).
  const roundTrip = post.some(
    (e) => (e.kind === "probe" || e.kind === "interceptor-nav") && !e.isError && HTTP_SUCCESS.test(e.resultText),
  );
  return roundTrip;
}

/** A pixel image was captured AND read (viewed) after the last frontend mutation. */
export function pixelViewed(ev: TxEvent[]): boolean {
  const after = lastCodeMutationSeq(ev);
  return ev.some((capture) =>
    capture.seq > after && (capture.kind === "interceptor-capture" || capture.kind === "gstack-capture") &&
    !capture.isError && !!capture.artifact && ev.some((read) =>
      read.seq > capture.seq && read.kind === "read-image" && read.target === capture.artifact,
    ),
  );
}

/** A test ran after the last code edit and its result shows a pass. */
export function testPassedAfterEdit(ev: TxEvent[]): boolean {
  const after = lastCodeMutationSeq(ev);
  return ev.some((e) => e.seq > after && e.kind === "test-run" && !e.isError && testResultPassed(e.resultText));
}

/** Evidence lives only inside a spawned agent's result text (pass-but-log). */
/** Scan an agent-result's TEXT for type-scoped evidence markers.
 *
 * DISPOSITION (2026-07-31): exported, zero call sites, deliberately retained.
 * This is the middle path for VerificationGate's sub-agent bypass — today any
 * spawned agent passes a claim unconditionally; wiring this would instead demand
 * the delegate at least REPORT evidence. Not wired yet because agent prose is
 * weaker than tool output (a hallucinating delegate writes "200 OK" having run
 * nothing), so the tighten/leave call waits on the `wouldBlock` counterfactual
 * the bypass now logs. Delete this if that corpus says the hole never bites.
 */
export function evidenceViaAgent(ev: TxEvent[], patt: RegExp): boolean {
  return ev.some((e) => e.kind === "agent-result" && patt.test(e.resultText));
}
