import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const captureSource = join(import.meta.dir, "Capture.sh");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type RunOptions = {
  initialState?: "minimized" | "normal";
  errorWindowId?: number;
  listedWindowId?: number;
  focusDuringLease?: boolean;
  focusAfterCapture?: boolean;
  boundFieldsAfterCapture?: boolean;
  signalDuringCapture?: boolean;
  restoreFails?: boolean;
  tabRestoreFails?: boolean;
  geometryRestoreFails?: boolean;
  preexistingOutput?: boolean;
  domCaptureFails?: boolean;
  frontmostChanges?: boolean;
  invalidWindowMetadata?: boolean;
  invalidFrontmostResponse?: boolean;
  minimizeAfterDomFailure?: boolean;
  outputIsDirectory?: boolean;
  wedgeCaptureFails?: boolean;
  args?: string[];
};

async function setup(options: RunOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "interceptor-capture-test-"));
  roots.push(root);
  const home = join(root, "home");
  const tools = join(root, "tools");
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  const output = join(root, "capture.png");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(tools), mkdir(bin), mkdir(stateDir)]);
  await copyFile(captureSource, join(tools, "Capture.sh"));
  await writeFile(join(tools, "PreflightIsolation.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(
    join(home, ".claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env"),
    'INTERCEPTOR_TEST_CONTEXT_ID="interceptor-test"\nINTERCEPTOR_WORKING_PROFILE_IDS="working-profile"\n',
    { flag: "w" },
  ).catch(async () => {
    const prefs = join(home, ".claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor");
    await mkdir(prefs, { recursive: true });
    await writeFile(join(prefs, "preferences.env"), 'INTERCEPTOR_TEST_CONTEXT_ID="interceptor-test"\nINTERCEPTOR_WORKING_PROFILE_IDS="working-profile"\n');
  });
  await writeFile(
    join(stateDir, "window"),
    `${options.initialState ?? "minimized"}\tfalse\n`,
  );
  await writeFile(join(stateDir, "frontmost-count"), "0\n");
  await writeFile(join(stateDir, "actions"), "");
  await writeFile(join(stateDir, "active-tab"), "7\n");
  await writeFile(join(stateDir, "geometry"), "0 33 1200 800\n");
  if (options.outputIsDirectory) await mkdir(output);
  if (options.preexistingOutput) await writeFile(output, "original-bytes");

  const interceptorStub = `#!/usr/bin/env bash
set -euo pipefail
state_dir="$FAKE_STATE_DIR"
cmd="\${1:-}"
shift || true
case "$cmd" in
  contexts)
    printf 'interceptor-test\\n'
    ;;
  open)
    printf '{"success":true}\\n'
    ;;
  screenshot)
    read -r state focused < "$state_dir/window"
    if [[ "$state" == "minimized" ]]; then
      printf 'error: window %s is minimized — DOM-render requires the window to be non-minimized\\n' "\${FAKE_ERROR_WINDOW_ID:-42}"
      exit 0
    fi
    out=""
    is_pixel=0
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--out" ]]; then out="$2"; shift 2
      elif [[ "$1" == "--pixel" ]]; then is_pixel=1; shift
      else shift; fi
    done
    if [[ "\${FAKE_DOM_CAPTURE_FAILS:-0}" == "1" && "$is_pixel" == "0" ]]; then
      if [[ "\${FAKE_MINIMIZE_AFTER_DOM_FAIL:-0}" == "1" ]]; then
        printf 'minimized\\tfalse\\n' > "$state_dir/window"
      fi
      printf 'DOM injection unavailable\\n'
      exit 0
    fi
    if [[ "\${FAKE_WEDGE_CAPTURE_FAILS:-0}" == "1" ]]; then
      printf 'native port disconnected\\n'
      exit 0
    fi
    printf 'image-bytes' > "$out"
    if [[ "\${FAKE_FOCUS_AFTER_CAPTURE:-0}" == "1" ]]; then
      printf 'normal\\ttrue\\n' > "$state_dir/window"
    fi
    if [[ "\${FAKE_BOUND_FIELDS_AFTER_CAPTURE:-0}" == "1" ]]; then
      printf '8\\n' > "$state_dir/active-tab"
      printf '10 44 1100 700\\n' > "$state_dir/geometry"
    fi
    printf '{"filePath":"%s"}\\n' "$out"
    if [[ "\${FAKE_SIGNAL_DURING_CAPTURE:-0}" == "1" ]]; then
      kill -TERM "$INTERCEPTOR_CAPTURE_WRAPPER_PID"
      sleep 0.1
    fi
    ;;
  window)
    [[ "\${1:-}" == "list" ]]
    if [[ "\${FAKE_INVALID_WINDOW_METADATA:-0}" == "1" ]]; then
      printf '{"success":true,"data":[{"id":42,"type":"normal","state":"minimized","focused":false,"left":"0","top":33,"width":1200,"height":800,"incognito":false,"tabs":[{"id":7,"active":true}]}]}\\n'
      exit 0
    fi
    read -r state focused < "$state_dir/window"
    read -r left top width height < "$state_dir/geometry"
    active_tab=$(cat "$state_dir/active-tab")
    printf '{"success":true,"data":[{"id":%s,"type":"normal","state":"%s","focused":%s,"left":%s,"top":%s,"width":%s,"height":%s,"incognito":false,"tabs":[{"id":%s,"active":true}]}]}\\n' "\${FAKE_LIST_WINDOW_ID:-42}" "$state" "$focused" "$left" "$top" "$width" "$height" "$active_tab"
    ;;
  raw)
    action="\${1:-}"
    action_type=$(printf '%s' "$action" | sed -nE 's/.*"type":"([^"]+)".*/\\1/p')
    if [[ "$action_type" == "tab_switch" ]]; then
      if [[ "\${FAKE_TAB_RESTORE_FAIL:-0}" == "1" ]]; then exit 1; fi
      tab_id=$(printf '%s' "$action" | sed -nE 's/.*"tabId":([0-9]+).*/\\1/p')
      printf '%s\\n' "$tab_id" > "$state_dir/active-tab"
      printf 'tab:%s\\n' "$tab_id" >> "$state_dir/actions"
      exit 0
    fi
    next_state=$(printf '%s' "$action" | sed -nE 's/.*"state":"([^"]+)".*/\\1/p')
    if [[ -z "$next_state" ]]; then
      if [[ "\${FAKE_GEOMETRY_RESTORE_FAIL:-0}" == "1" ]]; then exit 1; fi
      left=$(printf '%s' "$action" | sed -nE 's/.*"left":(-?[0-9]+).*/\\1/p')
      top=$(printf '%s' "$action" | sed -nE 's/.*"top":(-?[0-9]+).*/\\1/p')
      width=$(printf '%s' "$action" | sed -nE 's/.*"width":([0-9]+).*/\\1/p')
      height=$(printf '%s' "$action" | sed -nE 's/.*"height":([0-9]+).*/\\1/p')
      printf '%s %s %s %s\\n' "$left" "$top" "$width" "$height" > "$state_dir/geometry"
      printf 'geometry\\n' >> "$state_dir/actions"
      exit 0
    fi
    printf 'state:%s\\n' "$next_state" >> "$state_dir/actions"
    if [[ "$next_state" == "minimized" && "\${FAKE_RESTORE_FAIL:-0}" == "1" ]]; then exit 1; fi
    focused=false
    if [[ "$next_state" == "normal" && "\${FAKE_FOCUS_DURING:-0}" == "1" ]]; then focused=true; fi
    printf '%s\\t%s\\n' "$next_state" "$focused" > "$state_dir/window"
    ;;
  macos)
    [[ "\${1:-}" == "frontmost" ]]
    if [[ "\${FAKE_INVALID_FRONTMOST_RESPONSE:-0}" == "1" ]]; then
      printf '{"success":false,"error":"frontmost unavailable"}\\n'
      exit 0
    fi
    count=$(cat "$state_dir/frontmost-count")
    count=$((count + 1))
    printf '%s\\n' "$count" > "$state_dir/frontmost-count"
    if [[ "$count" -gt 1 && "\${FAKE_FRONTMOST_CHANGES:-0}" == "1" ]]; then
      printf '{"isActive":true,"bundleId":"changed.app","name":"Changed","pid":2}\\n'
    else
      printf '{"isActive":true,"bundleId":"stable.app","name":"Stable","pid":1}\\n'
    fi
    ;;
  *)
    printf 'unexpected interceptor command: %s\\n' "$cmd" >&2
    exit 91
    ;;
esac
`;
  await writeFile(join(bin, "interceptor"), interceptorStub);
  await writeFile(join(bin, "magick"), "#!/usr/bin/env bash\nprintf '0.100000'\n");
  await writeFile(join(bin, "pkill"), '#!/usr/bin/env bash\nprintf "global-kill\\n" >> "$FAKE_STATE_DIR/actions"\n');
  await Promise.all([
    chmod(join(tools, "Capture.sh"), 0o755),
    chmod(join(tools, "PreflightIsolation.sh"), 0o755),
    chmod(join(bin, "interceptor"), 0o755),
    chmod(join(bin, "magick"), 0o755),
    chmod(join(bin, "pkill"), 0o755),
  ]);

  const proc = Bun.spawnSync(
    ["bash", join(tools, "Capture.sh"), ...(options.args ?? ["--current"]), "--out", output],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        INTERCEPTOR_CAPTURE_INTERCEPTOR_BIN: join(bin, "interceptor"),
        INTERCEPTOR_CAPTURE_BUN_BIN: process.execPath,
        FAKE_STATE_DIR: stateDir,
        FAKE_ERROR_WINDOW_ID: String(options.errorWindowId ?? 42),
        FAKE_LIST_WINDOW_ID: String(options.listedWindowId ?? 42),
        FAKE_FOCUS_DURING: options.focusDuringLease ? "1" : "0",
        FAKE_FOCUS_AFTER_CAPTURE: options.focusAfterCapture ? "1" : "0",
        FAKE_BOUND_FIELDS_AFTER_CAPTURE: options.boundFieldsAfterCapture ? "1" : "0",
        FAKE_SIGNAL_DURING_CAPTURE: options.signalDuringCapture ? "1" : "0",
        FAKE_RESTORE_FAIL: options.restoreFails ? "1" : "0",
        FAKE_TAB_RESTORE_FAIL: options.tabRestoreFails ? "1" : "0",
        FAKE_GEOMETRY_RESTORE_FAIL: options.geometryRestoreFails ? "1" : "0",
        FAKE_DOM_CAPTURE_FAILS: options.domCaptureFails ? "1" : "0",
        FAKE_FRONTMOST_CHANGES: options.frontmostChanges ? "1" : "0",
        FAKE_INVALID_WINDOW_METADATA: options.invalidWindowMetadata ? "1" : "0",
        FAKE_INVALID_FRONTMOST_RESPONSE: options.invalidFrontmostResponse ? "1" : "0",
        FAKE_MINIMIZE_AFTER_DOM_FAIL: options.minimizeAfterDomFailure ? "1" : "0",
        FAKE_WEDGE_CAPTURE_FAILS: options.wedgeCaptureFails ? "1" : "0",
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  const outputStat = await stat(output).catch(() => undefined);
  const exists = outputStat?.isFile() ?? false;
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exists,
    state: await readFile(join(stateDir, "window"), "utf8"),
    actions: await readFile(join(stateDir, "actions"), "utf8"),
    outputBytes: exists ? await readFile(output, "utf8") : "",
    output,
  };
}

describe("Capture.sh minimized-window state lease", () => {
  test("captures without operator action and restores exact minimized state", async () => {
    const result = await setup();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(result.output);
    expect(result.exists).toBe(true);
    expect(result.state.trim()).toBe("minimized\tfalse");
    expect(result.actions.trim().split("\n")).toEqual([
      "state:normal", "state:normal", "state:minimized",
    ]);
    expect(result.stderr).not.toContain("operator");
  });

  test("supports an explicitly requested pixel capture under the same lease", async () => {
    const result = await setup({ args: ["--current", "--pixel"] });
    expect(result.exitCode).toBe(0);
    expect(result.exists).toBe(true);
    expect(result.state.trim()).toBe("minimized\tfalse");
  });

  test("falls back to a separately leased pixel capture after a restored DOM failure", async () => {
    const result = await setup({ domCaptureFails: true });
    expect(result.exitCode).toBe(0);
    expect(result.exists).toBe(true);
    expect(result.state.trim()).toBe("minimized\tfalse");
    expect(result.actions.match(/state:normal/g)?.length).toBe(4);
    expect(result.actions.match(/state:minimized/g)?.length).toBe(2);
  });

  test("leases a window that becomes minimized only during pixel recovery", async () => {
    const result = await setup({
      initialState: "normal",
      domCaptureFails: true,
      minimizeAfterDomFailure: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.exists).toBe(true);
    expect(result.state.trim()).toBe("minimized\tfalse");
    expect(result.actions).toContain("state:normal");
    expect(result.actions).toContain("state:minimized");
  });

  test("rejects an existing directory as the final output path", async () => {
    const result = await setup({ outputIsDirectory: true });
    expect(result.exitCode).toBe(2);
    expect(result.exists).toBe(false);
    expect(result.actions).toBe("");
    expect(result.stderr).toContain("must name an image file");
  });

  test("fails closed on a wedge without terminating the shared daemon", async () => {
    const result = await setup({ initialState: "normal", wedgeCaptureFails: true });
    expect(result.exitCode).toBe(9);
    expect(result.exists).toBe(false);
    expect(result.actions).not.toContain("global-kill");
    expect(result.stderr).toContain("shared interceptor daemon was not restarted");
  });

  test("refuses a minimized error whose window is absent from the pinned context", async () => {
    const result = await setup({ errorWindowId: 99, listedWindowId: 42 });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.actions).toBe("");
    expect(result.stderr).toContain("not exactly present in pinned context");
    expect(result.stderr).not.toContain("Restore the pinned");
  });

  test("rejects non-integer window metadata before issuing a raw action", async () => {
    const result = await setup({ invalidWindowMetadata: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.actions).toBe("");
    expect(result.stderr).toContain("not exactly present in pinned context");
  });

  test("rejects a status-zero frontmost error envelope before changing window state", async () => {
    const result = await setup({ invalidFrontmostResponse: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.actions).toBe("");
    expect(result.stderr).toContain("cannot prove frontmost app");
  });

  test("preserves a pre-existing output when the lease fails before capture", async () => {
    const result = await setup({ errorWindowId: 99, listedWindowId: 42, preexistingOutput: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(true);
    expect(result.outputBytes).toBe("original-bytes");
  });

  test("rejects the artifact when exact state restoration fails", async () => {
    const result = await setup({ restoreFails: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.stderr).toContain("not proven restored");
  });

  test("re-minimizes even when active-tab restoration fails", async () => {
    const result = await setup({ tabRestoreFails: true, boundFieldsAfterCapture: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.state.trim()).toBe("minimized\tfalse");
  });

  test("re-minimizes even when geometry restoration fails", async () => {
    const result = await setup({ geometryRestoreFails: true, boundFieldsAfterCapture: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.state.trim()).toBe("minimized\tfalse");
  });

  test("rejects the artifact when the frontmost app changes", async () => {
    const result = await setup({ frontmostChanges: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.state.trim()).toBe("minimized\tfalse");
    expect(result.stderr).toContain("frontmost app changed");
  });

  test("aborts and restores when the leased window becomes focused", async () => {
    const result = await setup({ focusDuringLease: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.state.trim()).toBe("minimized\tfalse");
    expect(result.stderr).toContain("changed during capture");
  });

  test("rejects a capture that changes focus after the initial lease check", async () => {
    const result = await setup({ focusAfterCapture: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.state.trim()).toBe("minimized\tfalse");
    expect(result.stderr).toContain("changed during capture");
  });

  test("restores active tab and geometry after a rejected capture", async () => {
    const result = await setup({ boundFieldsAfterCapture: true });
    expect(result.exitCode).toBe(13);
    expect(result.exists).toBe(false);
    expect(result.state.trim()).toBe("minimized\tfalse");
    expect(result.actions).toContain("tab:7");
    expect(result.actions).toContain("geometry");
  });

  test("signal cleanup removes the artifact and restores exact state", async () => {
    const result = await setup({ signalDuringCapture: true });
    expect(result.exitCode).toBe(143);
    expect(result.exists).toBe(false);
    expect(result.state.trim()).toBe("minimized\tfalse");
  });

  test("does not mutate window state when capture is already available", async () => {
    const result = await setup({ initialState: "normal" });
    expect(result.exitCode).toBe(0);
    expect(result.exists).toBe(true);
    expect(result.actions).toBe("");
    expect(result.state.trim()).toBe("normal\tfalse");
  });
});
