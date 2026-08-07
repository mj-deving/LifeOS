#!/usr/bin/env bash
# Capture.sh — the ONLY sanctioned way to take an Interceptor screenshot.
#
# Contract:
#   - Resolves the pinned test context from preferences.env and REFUSES to run
#     against any other context. Never falls back to Default. Never uses
#     screencapture/osascript.
#   - DOM-render first (the engineered-robust default; needs no foreground).
#     If the exact pinned-context window is minimized, temporarily leases only
#     that window's state (minimized -> normal -> minimized), verifies focus did
#     not move, and retries without operator action.
#   - Tries the alternate screenshot transport and, for macos_* paths only, a
#     loaded-but-dead bridge heal. It never restarts the shared daemon; an
#     unresolved wedge becomes an explicit runtime gate.
#   - On success prints EXACTLY one line — the absolute path of the saved image —
#     to stdout, exit 0. On failure: structured remediation to stderr, distinct
#     non-zero exit per failure class. Never narrates.
#
# Usage:
#   Tools/Capture.sh <url|--current> [--full] [--out <path>]
#   Tools/Capture.sh --help
#
# Exit codes: 0 ok; 2 bad args; 3 preflight failed (propagated); 7 target denied
# (Default/working profile); 8 test-context unset; 9 capture failed after recovery;
# 10 stale extension (operator must reload); 11 empty/missing image after capture;
# 12 BLANK/DEGENERATE capture — image landed but is near-uniform (the black-frame
#    failure: page unhydrated or mid entrance-animation). A blank frame is NEVER a
#    successful capture — it is a wedged verifier, so it fails hard (defer, never
#    treat a black frame as evidence); 13 minimized-window state lease failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_PREFS="${HOME}/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env"

usage() {
    cat <<EOF
Capture.sh — sanctioned Interceptor screenshot wrapper.

Usage:
  Capture.sh <url>          Navigate the pinned test context to <url>, capture.
  Capture.sh --current      Capture the pinned test context's current page.
  Capture.sh ... --full     Full-page capture (default is viewport).
  Capture.sh ... --pixel    Skip DOM-render, capture the real compositor frame
                            directly (use on dark/animated pages that DOM-render
                            snaps blank before hydration). Needs a non-minimized
                            window; the wrapper leases that state without focus.
  Capture.sh ... --out PATH  Write to PATH (default: ~/Downloads/interceptor-capture-*.png).
  Capture.sh --help

Always targets only INTERCEPTOR_TEST_CONTEXT_ID from preferences.env. Refuses
Default / working profiles. Prints only the saved file path on success. A blank /
near-uniform capture is rejected (exit 12), never returned as success.
If the pinned test window is minimized, the wrapper temporarily makes only that
isolated window non-minimized, verifies it remains unfocused, captures, and
restores every bound observable window field. No operator action or
Default-profile fallback.
EOF
}

# --- arg parse ---
TARGET_URL=""
USE_CURRENT=0
FULL=0
FORCE_PIXEL=0
OUT=""

if [ "$#" -eq 0 ]; then
    usage >&2
    exit 2
fi

while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --current)
            USE_CURRENT=1
            shift
            ;;
        --full)
            FULL=1
            shift
            ;;
        --pixel)
            FORCE_PIXEL=1
            shift
            ;;
        --out)
            OUT="${2:-}"
            if [ -z "$OUT" ]; then
                echo "Capture.sh: --out requires a path" >&2
                exit 2
            fi
            shift 2
            ;;
        --*)
            echo "Capture.sh: unknown flag $1" >&2
            usage >&2
            exit 2
            ;;
        *)
            if [ -n "$TARGET_URL" ]; then
                echo "Capture.sh: multiple URLs given ($TARGET_URL, $1)" >&2
                exit 2
            fi
            TARGET_URL="$1"
            shift
            ;;
    esac
done

if [ "$USE_CURRENT" -eq 0 ] && [ -z "$TARGET_URL" ]; then
    echo "Capture.sh: provide a <url> or --current" >&2
    exit 2
fi
if [ "$USE_CURRENT" -eq 1 ] && [ -n "$TARGET_URL" ]; then
    echo "Capture.sh: --current and a <url> are mutually exclusive" >&2
    exit 2
fi

# --- 1. resolve pinned target ---
if [ -f "$USER_PREFS" ]; then
    # shellcheck disable=SC1090
    . "$USER_PREFS"
fi
CTX="${INTERCEPTOR_TEST_CONTEXT_ID:-}"
WORKING_PROFILE_IDS="${INTERCEPTOR_WORKING_PROFILE_IDS:-}"
INTERCEPTOR_BIN="${INTERCEPTOR_CAPTURE_INTERCEPTOR_BIN:-$(command -v interceptor || true)}"
BUN_BIN="${INTERCEPTOR_CAPTURE_BUN_BIN:-$(command -v bun || true)}"
export INTERCEPTOR_CAPTURE_WRAPPER_PID="$$"

if [ -z "$CTX" ]; then
    echo "Capture.sh: INTERCEPTOR_TEST_CONTEXT_ID unset in preferences.env — refusing (no default-to-Default)." >&2
    exit 8
fi

# --- 2. hardened preflight gate (propagate its exit + stderr verbatim) ---
if ! bash "$SCRIPT_DIR/PreflightIsolation.sh" >&2; then
    # Preflight already printed structured remediation. Do not try anyway.
    exit 3
fi

# --- 3. target-deny re-check (defense in depth; state can change post-preflight) ---
target_denied() {
    local id="$1"
    # "Default" name is always denied.
    if printf '%s\n' "$id" | grep -qiE '(^|[^a-z])default([^a-z]|$)'; then
        return 0
    fi
    if [ -n "$WORKING_PROFILE_IDS" ]; then
        local _d
        IFS=',' read -ra _arr <<< "$WORKING_PROFILE_IDS"
        for _d in "${_arr[@]}"; do
            _d="$(printf '%s' "$_d" | sed 's/^[ \t]*//;s/[ \t]*$//')"
            [ -z "$_d" ] && continue
            [ "$_d" = "$id" ] && return 0
        done
    fi
    return 1
}

if target_denied "$CTX"; then
    echo "Capture.sh: pinned target $CTX is a denied Default/working profile — refusing." >&2
    exit 7
fi

# Confirm the pinned context is actually in the live connected set (exact match).
contexts_now="$("$INTERCEPTOR_BIN" contexts 2>&1 || true)"
if ! printf '%s\n' "$contexts_now" \
    | grep -v '→ contexts' \
    | awk -v want="$CTX" '{ gsub(/^[ \t]+|[ \t]+$/, "", $0) } $0 == want { f=1 } END { exit(f?0:1) }'; then
    echo "Capture.sh: pinned context $CTX not in live connected set (rot?). Re-run preflight remediation." >&2
    printf '%s\n' "$contexts_now" | sed 's/^/  /' >&2
    exit 3
fi

# --- 4. resolve output path (review artifacts go to the downloads dir per OPERATIONAL_RULES;
#         LIFEOS_DOWNLOADS_DIR overrides ~/Downloads when set — public PR #1535, @anikinsasha) ---
if [ -z "$OUT" ]; then
    ts="$(date +%Y%m%d-%H%M%S)"
    rand="$$"
    OUT="${LIFEOS_DOWNLOADS_DIR:-${HOME}/Downloads}/interceptor-capture-${ts}-${rand}.png"
fi
FINAL_OUT="$OUT"
FINAL_DIR="$(dirname "$FINAL_OUT")"
if [ -d "$FINAL_OUT" ]; then
    echo "Capture.sh: --out must name an image file, not a directory: $FINAL_OUT" >&2
    exit 2
fi
mkdir -p "$FINAL_DIR"
STAGED_DIR="$(mktemp -d "$FINAL_DIR/.interceptor-capture.XXXXXX")"
OUT="$STAGED_DIR/$(basename "$FINAL_OUT")"

cleanup_staged_capture() {
    local failed=0
    if [ -e "$OUT" ] && ! rm -f "$OUT" 2>/dev/null; then
        echo "Capture.sh: failed to remove rejected staged capture $OUT" >&2
        failed=1
    fi
    if [ -d "$STAGED_DIR" ] && ! rmdir "$STAGED_DIR" 2>/dev/null; then
        echo "Capture.sh: failed to remove staged capture directory $STAGED_DIR" >&2
        failed=1
    fi
    return "$failed"
}

publish_capture() {
    if ! INTERCEPTOR_STAGED_OUT="$OUT" INTERCEPTOR_FINAL_OUT="$FINAL_OUT" "$BUN_BIN" -e '
      import { rename, stat } from "node:fs/promises";
      const source = process.env.INTERCEPTOR_STAGED_OUT;
      const destination = process.env.INTERCEPTOR_FINAL_OUT;
      if (!source || !destination) process.exit(2);
      try {
        if ((await stat(destination)).isDirectory()) process.exit(3);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(source, destination);
    ' 2>/dev/null; then
        echo "Capture.sh: validated capture could not be published to $FINAL_OUT" >&2
        exit 11
    fi
    rmdir "$STAGED_DIR" 2>/dev/null || true
    trap - EXIT HUP INT TERM
    printf '%s\n' "$FINAL_OUT"
    exit 0
}

trap cleanup_staged_capture EXIT

# Build common flag arrays.
SS_FLAGS=(--context "$CTX" --save --out "$OUT")
[ "$FULL" -eq 1 ] && SS_FLAGS+=(--full)

# --- helpers ---
navigate_if_needed() {
    if [ -n "$TARGET_URL" ]; then
        "$INTERCEPTOR_BIN" open --context "$CTX" "$TARGET_URL" >/dev/null 2>&1 || return 1
    fi
    return 0
}

image_landed() {
    [ -s "$OUT" ]
}

# --- degeneracy guard ---------------------------------------------------------
# A capture that LANDED but is near-uniform (all-black / blank) is NOT a
# successful capture — it is the framer-motion-before-hydration failure, where
# every animated element sits at opacity:0 and the DOM-render snaps a black
# rectangle. Existence of a non-empty PNG proved nothing about content; this is
# the guard that makes "a file landed" insufficient. std-dev via ImageMagick was
# the widest-margin separator of the metrics measured (maxima/range/unique-colors
# all overlap — a blank frame with one stray bright pixel hits maxima 1.0):
# observed blank frames cluster at 0.008-0.012, real content at >=0.022 (a very
# dark dim-text page) up to 0.24 (bright content). Default 0.017 sits at the
# midpoint, ~0.005 margin each side. The failure direction is deliberately SAFE:
# a borderline-dark legit page just under the line is conservatively REJECTED
# (exit 12), forcing a --pixel + a human look, never a false "verified". If
# ImageMagick is absent the probe cannot run — warn, but PASS (UNKNOWN != MISSING:
# never block on our own blind spot). Override with INTERCEPTOR_MIN_STDDEV.
MIN_STDDEV="${INTERCEPTOR_MIN_STDDEV:-0.017}"

# Loudly record a skipped guard so "the blank-frame check didn't run" is
# discoverable, never silent (cross-vendor audit 2026-07-07: the fail-open path
# reproduced the original bug invisibly on any magick-less host).
guard_skipped() {
    local reason="$1"
    echo "Capture.sh: ⚠️  BLANK-FRAME GUARD SKIPPED ($reason) — this capture is NOT checked for a black/blank frame; do not treat it as pixel-verified without looking. Install ImageMagick (brew install imagemagick) to enable." >&2
    local log="${HOME}/.claude/LIFEOS/MEMORY/OBSERVABILITY/capture-guard.jsonl"
    mkdir -p "$(dirname "$log")" 2>/dev/null || true
    printf '{"ts":"%s","event":"guard-skipped","reason":"%s","out":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$reason" "$OUT" >> "$log" 2>/dev/null || true
}

content_ok() {
    [ -s "$OUT" ] || return 1
    if ! command -v magick >/dev/null 2>&1; then
        guard_skipped "imagemagick-absent"
        return 0
    fi
    local sd
    sd="$(magick "$OUT" -format '%[fx:standard_deviation]' info: 2>/dev/null)"
    if [ -z "$sd" ]; then
        guard_skipped "stddev-probe-empty"
        return 0
    fi
    # ok (return 0) iff sd >= MIN_STDDEV
    awk -v s="$sd" -v t="$MIN_STDDEV" 'BEGIN{ exit !((s+0) >= (t+0)) }'
}

# interceptor screenshot prints JSON including "filePath" — the path it ACTUALLY
# wrote. The --pixel path (captureVisibleTab) ignores --out and saves to a
# daemon-chosen temp path, so after every capture we reconcile: if $OUT wasn't
# populated, lift the real file from filePath into $OUT. This is what makes the
# working pixel fallback actually satisfy the wrapper's contract.
resolve_saved() {
    local out_text="$1" fp
    [ -s "$OUT" ] && return 0
    fp="$(printf '%s\n' "$out_text" | grep -oE '"filePath"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*:[[:space:]]*"([^"]+)".*/\1/')"
    if [ -n "$fp" ] && [ -s "$fp" ]; then
        # mv, not cp: cp left the daemon-chosen temp file behind as a full-size
        # stray duplicate on every --pixel capture (public PR #1535, @anikinsasha)
        mv -f "$fp" "$OUT" 2>/dev/null && return 0
    fi
    return 1
}

# Returns 0 if stderr text signals a stale-extension / runner.js load failure.
is_stale_extension() {
    printf '%s' "$1" | grep -qiE 'screenshot-runner\.js|html-to-image library not loaded|could not load file'
}

is_minimized_window() {
    printf '%s' "$1" | grep -qiE 'window [0-9]+ is minimized'
}

fail_minimized_window() {
    cat >&2 <<EOF
Capture.sh: MINIMIZED-WINDOW RECOVERY FAILED (exit 13) — the exact isolated
test-profile window could not be leased and restored without changing focus.

No Default/working-profile window, raw OS screenshot, AppleScript, or operator
clickwork was used. The capture artifact, if any, was rejected.
  last error: $err
EOF
    exit 13
}

# Heal a loaded-but-dead macOS bridge (the "native port disconnected" cause).
heal_bridge() {
    [ -x "$SCRIPT_DIR/HealBridge.sh" ] && bash "$SCRIPT_DIR/HealBridge.sh" >/dev/null 2>&1 || true
}

dom_capture() {
    "$INTERCEPTOR_BIN" screenshot "${SS_FLAGS[@]}" 2>&1
}

pixel_capture() {
    "$INTERCEPTOR_BIN" screenshot "${SS_FLAGS[@]}" --pixel 2>&1
}

# --- 5/6/7. capture with bounded recovery. DOM-first, then a classified
# recovery move. A minimized pinned window gets one exact, focus-free state lease.
# NOTE: the wedge path (heal_bridge → pixel) issues at most 2 run_one calls.
# A degenerate DOM frame is treated as a failure so it escalates to --pixel. ---
attempt=0
err=""

# The interceptor CLI exits 0 even on "native port disconnected", so success is
# decided by an image actually landing (after path reconciliation), NOT exit code.
run_one() {
    # $1 = path: "dom" or "pixel"
    rm -f "$OUT" 2>/dev/null || true
    if ! navigate_if_needed; then
        err="navigation to $TARGET_URL failed"
        return 1
    fi
    local out_text
    if [ "$1" = "pixel" ]; then
        out_text="$(pixel_capture)"
    else
        out_text="$(dom_capture)"
    fi
    if resolve_saved "$out_text"; then
        # Landing is necessary but NOT sufficient — a blank/degenerate frame is a
        # failed capture, not a success. Reject it so the DOM path escalates to
        # --pixel and a genuinely-blank final frame fails hard (exit 12).
        if content_ok; then
            return 0
        fi
        err="degenerate/blank image on $1 capture (std-dev < ${MIN_STDDEV}) — page unhydrated or mid entrance-animation"
        return 1
    fi
    err="$out_text"
    return 1
}

# Parse one exact browser-window record from `window list --json`. The context
# gate has already denied Default/working profiles; the minimized error supplies
# the target window ID, so multiple windows in the isolated profile remain safe.
window_record() {
    local window_id="$1" listing
    [ -n "$INTERCEPTOR_BIN" ] && [ -n "$BUN_BIN" ] || return 1
    listing="$("$INTERCEPTOR_BIN" window list --context "$CTX" --json 2>/dev/null)" || return 1
    INTERCEPTOR_WINDOW_ID="$window_id" "$BUN_BIN" -e '
      const payload = JSON.parse(await Bun.stdin.text());
      if (payload?.success !== true) process.exit(1);
      const id = Number(process.env.INTERCEPTOR_WINDOW_ID);
      if (!Number.isSafeInteger(id) || id < 0) process.exit(1);
      const matches = Array.isArray(payload?.data) ? payload.data.filter((w) => w?.id === id) : [];
      if (matches.length !== 1) process.exit(2);
      const w = matches[0];
      const active = Array.isArray(w.tabs) ? w.tabs.filter((t) => t?.active === true) : [];
      const states = new Set(["normal", "minimized", "maximized", "fullscreen"]);
      const types = new Set(["normal", "popup", "panel", "app", "devtools"]);
      const integer = (v) => Number.isSafeInteger(v);
      if (active.length !== 1 || !integer(active[0]?.id) || active[0].id < 0) process.exit(4);
      if (!states.has(w.state) || !types.has(w.type)) process.exit(5);
      if (typeof w.focused !== "boolean" || typeof w.incognito !== "boolean") process.exit(6);
      if (![w.left, w.top, w.width, w.height].every(integer) || w.width < 1 || w.height < 1) process.exit(7);
      const fields = [w.state, String(w.focused), w.left, w.top, w.width, w.height, active[0].id, w.type, String(w.incognito)];
      console.log(fields.join("\t"));
    ' <<<"$listing"
}

minimized_window_id() {
    printf '%s\n' "$1" | sed -nE 's/.*window ([0-9]+) is minimized.*/\1/p' | head -1
}

set_window_state() {
    local window_id="$1" state="$2" action
    action="$(INTERCEPTOR_WINDOW_ID="$window_id" INTERCEPTOR_WINDOW_STATE="$state" "$BUN_BIN" -e '
      const id = Number(process.env.INTERCEPTOR_WINDOW_ID);
      const state = process.env.INTERCEPTOR_WINDOW_STATE;
      if (!Number.isSafeInteger(id) || id < 0 || !["normal", "minimized"].includes(state)) process.exit(2);
      console.log(JSON.stringify({ type: "window_resize", windowId: id, state }));
    ')" || return 1
    "$INTERCEPTOR_BIN" raw "$action" --context "$CTX" >/dev/null 2>&1
}

set_active_tab() {
    local tab_id="$1" action
    action="$(INTERCEPTOR_TAB_ID="$tab_id" "$BUN_BIN" -e '
      const id = Number(process.env.INTERCEPTOR_TAB_ID);
      if (!Number.isSafeInteger(id) || id < 0) process.exit(2);
      console.log(JSON.stringify({ type: "tab_switch", tabId: id }));
    ')" || return 1
    "$INTERCEPTOR_BIN" raw "$action" --context "$CTX" >/dev/null 2>&1
}

set_window_geometry() {
    local window_id="$1" left="$2" top="$3" width="$4" height="$5" action
    action="$(INTERCEPTOR_WINDOW_ID="$window_id" INTERCEPTOR_LEFT="$left" INTERCEPTOR_TOP="$top" \
      INTERCEPTOR_WIDTH="$width" INTERCEPTOR_HEIGHT="$height" "$BUN_BIN" -e '
        const values = ["INTERCEPTOR_WINDOW_ID", "INTERCEPTOR_LEFT", "INTERCEPTOR_TOP", "INTERCEPTOR_WIDTH", "INTERCEPTOR_HEIGHT"]
          .map((key) => Number(process.env[key]));
        const [windowId, left, top, width, height] = values;
        if (!values.every(Number.isSafeInteger) || windowId < 0 || width < 1 || height < 1) process.exit(2);
        console.log(JSON.stringify({ type: "window_resize", windowId, left, top, width, height }));
      ')" || return 1
    "$INTERCEPTOR_BIN" raw "$action" --context "$CTX" >/dev/null 2>&1
}

restore_bound_window_state() {
    local window_id="$1" record="$2"
    local left top width height active_tab failed=0 current_record current_active current_geometry
    left="$(printf '%s' "$record" | cut -f3)"
    top="$(printf '%s' "$record" | cut -f4)"
    width="$(printf '%s' "$record" | cut -f5)"
    height="$(printf '%s' "$record" | cut -f6)"
    active_tab="$(printf '%s' "$record" | cut -f7)"
    set_window_state "$window_id" normal || failed=1
    current_record="$(window_record "$window_id" 2>/dev/null || true)"
    current_active="$(printf '%s' "$current_record" | cut -f7)"
    current_geometry="$(printf '%s' "$current_record" | cut -f3-6)"
    if [ "$current_active" != "$active_tab" ]; then
        set_active_tab "$active_tab" || failed=1
    fi
    if [ "$current_geometry" != "${left}"$'\t'"${top}"$'\t'"${width}"$'\t'"${height}" ]; then
        set_window_geometry "$window_id" "$left" "$top" "$width" "$height" || failed=1
    fi
    set_window_state "$window_id" minimized || failed=1
    return "$failed"
}

frontmost_record() {
    local response
    response="$("$INTERCEPTOR_BIN" macos frontmost --json 2>/dev/null)" || return 1
    "$BUN_BIN" -e '
      const payload = JSON.parse(await Bun.stdin.text());
      if (payload?.isActive !== true) process.exit(2);
      if (typeof payload.name !== "string" || payload.name.length < 1) process.exit(3);
      if (typeof payload.bundleId !== "string" || payload.bundleId.length < 1) process.exit(4);
      if (!Number.isSafeInteger(payload.pid) || payload.pid < 1) process.exit(5);
      console.log(JSON.stringify({ name: payload.name, bundleId: payload.bundleId, pid: payload.pid }));
    ' <<<"$response"
}

LEASE_ACTIVE=0
LEASE_WINDOW_ID=""
LEASE_BEFORE_RECORD=""
MINIMIZED_TARGET_WINDOW_ID=""
restore_minimized_lease_on_exit() {
    if [ "$LEASE_ACTIVE" -eq 1 ] && [ -n "$LEASE_WINDOW_ID" ]; then
        local restored_record=""
        rm -f "$OUT" 2>/dev/null || true
        if restore_bound_window_state "$LEASE_WINDOW_ID" "$LEASE_BEFORE_RECORD" >/dev/null 2>&1; then
            restored_record="$(window_record "$LEASE_WINDOW_ID" 2>/dev/null || true)"
        fi
        if [ -z "$LEASE_BEFORE_RECORD" ] || [ "$restored_record" != "$LEASE_BEFORE_RECORD" ]; then
            echo "Capture.sh: emergency cleanup could not prove restoration of all bound fields for window $LEASE_WINDOW_ID" >&2
        fi
    fi
    return 0
}

cleanup_capture_exit() {
    restore_minimized_lease_on_exit || true
    cleanup_staged_capture || true
}

handle_minimized_lease_signal() {
    local exit_code="$1"
    cleanup_capture_exit
    trap - EXIT HUP INT TERM
    exit "$exit_code"
}

capture_with_minimized_lease() {
    local mode="$1" window_id before_record normal_record during_record final_record
    local front_before front_during front_after before_geometry normal_geometry capture_error invariant_error
    local capture_ok=0 restore_ok=0

    window_id="${MINIMIZED_TARGET_WINDOW_ID:-$(minimized_window_id "$err")}"
    if [ -z "$window_id" ]; then
        err="minimized-window error did not expose an exact numeric window ID: $err"
        return 1
    fi
    MINIMIZED_TARGET_WINDOW_ID="$window_id"
    before_record="$(window_record "$window_id")" || {
        err="minimized window $window_id is not exactly present in pinned context $CTX"
        return 1
    }
    if [ "$(printf '%s' "$before_record" | cut -f1)" != "minimized" ] \
        || [ "$(printf '%s' "$before_record" | cut -f2)" != "false" ]; then
        err="window $window_id is not an unfocused minimized window in pinned context"
        return 1
    fi
    front_before="$(frontmost_record)" || {
        err="cannot prove frontmost app before minimized-window lease"
        return 1
    }

    LEASE_WINDOW_ID="$window_id"
    LEASE_BEFORE_RECORD="$before_record"
    LEASE_ACTIVE=1
    trap cleanup_capture_exit EXIT
    trap 'handle_minimized_lease_signal 129' HUP
    trap 'handle_minimized_lease_signal 130' INT
    trap 'handle_minimized_lease_signal 143' TERM

    if ! set_window_state "$window_id" normal; then
        err="failed to lease window $window_id from minimized to normal"
        return 1
    fi
    normal_record="$(window_record "$window_id")" || {
        err="window $window_id disappeared after state lease"
        return 1
    }
    before_geometry="$(printf '%s' "$before_record" | cut -f3-)"
    normal_geometry="$(printf '%s' "$normal_record" | cut -f3-)"
    if [ "$(printf '%s' "$normal_record" | cut -f1)" != "normal" ] \
        || [ "$(printf '%s' "$normal_record" | cut -f2)" != "false" ] \
        || [ "$before_geometry" != "$normal_geometry" ]; then
        err="window $window_id lease changed focus or geometry"
    elif run_one "$mode"; then
        capture_ok=1
    else
        capture_error="$err"
    fi

    during_record="$(window_record "$window_id" 2>/dev/null || true)"
    front_during="$(frontmost_record 2>/dev/null || true)"
    if [ -z "$during_record" ] \
        || [ "$(printf '%s' "$during_record" | cut -f1)" != "normal" ] \
        || [ "$(printf '%s' "$during_record" | cut -f2)" != "false" ] \
        || [ "$(printf '%s' "$during_record" | cut -f3-)" != "$before_geometry" ] \
        || [ -z "$front_during" ] || [ "$front_during" != "$front_before" ]; then
        capture_ok=0
        invariant_error="window focus, active tab, geometry, or frontmost app changed during capture"
        err="$invariant_error"
    fi

    if restore_bound_window_state "$window_id" "$before_record"; then
        final_record="$(window_record "$window_id" 2>/dev/null || true)"
        if [ "$final_record" = "$before_record" ]; then
            restore_ok=1
        fi
    fi
    front_after="$(frontmost_record 2>/dev/null || true)"

    if [ "$restore_ok" -eq 1 ]; then
        LEASE_ACTIVE=0
        LEASE_WINDOW_ID=""
        LEASE_BEFORE_RECORD=""
        trap cleanup_staged_capture EXIT
        trap - HUP INT TERM
    fi

    if [ "$capture_ok" -eq 1 ] && [ "$restore_ok" -eq 1 ] \
        && [ -n "$front_after" ] && [ "$front_before" = "$front_after" ]; then
        return 0
    fi

    if [ "$restore_ok" -ne 1 ]; then
        err="window $window_id was not proven restored across all bound minimized-state fields"
    elif [ -z "$front_after" ] || [ "$front_before" != "$front_after" ]; then
        err="frontmost app changed during minimized-window lease"
    elif [ -n "${invariant_error:-}" ]; then
        err="$invariant_error"
    elif [ -n "${capture_error:-}" ]; then
        err="$capture_error"
    elif [ -z "$err" ]; then
        err="capture failed inside minimized-window lease"
    fi
    if [ "$restore_ok" -eq 1 ] \
        && [ -n "$front_after" ] && [ "$front_before" = "$front_after" ] \
        && [ -z "${invariant_error:-}" ]; then
        return 2
    fi
    return 1
}

WINDOW_LEASE_REQUIRED=0
run_recovery_mode() {
    local mode="$1" lease_rc=0
    if [ "$WINDOW_LEASE_REQUIRED" -eq 0 ]; then
        if run_one "$mode"; then
            return 0
        fi
        if ! is_minimized_window "$err"; then
            return 1
        fi
        WINDOW_LEASE_REQUIRED=1
        MINIMIZED_TARGET_WINDOW_ID="$(minimized_window_id "$err")"
    fi
    capture_with_minimized_lease "$mode" || lease_rc=$?
    if [ "$lease_rc" -eq 1 ]; then
        fail_minimized_window
    fi
    return "$lease_rc"
}

# Attempt 1. --pixel forces the real compositor frame (known dark/animated pages);
# otherwise DOM-render first (engineered-robust default, needs no foreground).
attempt=1
if [ "$FORCE_PIXEL" -eq 1 ]; then
    if run_one pixel; then
        publish_capture
    fi
elif run_one dom; then
    publish_capture
fi

if is_minimized_window "$err"; then
    WINDOW_LEASE_REQUIRED=1
    if [ "$FORCE_PIXEL" -eq 1 ]; then
        lease_mode="pixel"
    else
        lease_mode="dom"
    fi
    lease_rc=0
    capture_with_minimized_lease "$lease_mode" || lease_rc=$?
    if [ "$lease_rc" -eq 0 ]; then
        publish_capture
    fi
    if [ "$lease_rc" -eq 1 ]; then
        fail_minimized_window
    fi
fi

# Classify failure and pick the single recovery move (cap = 2 attempts).
if is_stale_extension "$err"; then
    cat >&2 <<EOF
Capture.sh: stale/unloaded extension — screenshot-runner.js failed to load.

REMEDIATION (operator):
  In the test profile: chrome://extensions/ -> Interceptor -> Reload (or
  Load Unpacked from ~/.claude/skills/Interceptor/Extension/). If you just
  upgraded the binary, re-pin via the Update workflow first.
EOF
    exit 10
fi

# Wedge signatures: timeout / native port disconnected → try the OTHER capture
# path (different WS message type often unwedges). The daemon is shared across
# contexts and must not be restarted by a capture lane.
attempt=2
if printf '%s' "$err" | grep -qiE 'timeout|timed out|native port disconnected|not reachable'; then
    # "native port disconnected" IS the dead/wedged bridge — heal it first, then
    # swap to --pixel (captureVisibleTab; different path that survives a bridge wedge).
    heal_bridge
    if run_recovery_mode pixel; then
        publish_capture
    fi
    if is_stale_extension "$err"; then
        cat >&2 <<EOF
Capture.sh: stale/unloaded extension after bounded bridge/capture recovery.
REMEDIATION: reload the Interceptor extension (Load Unpacked from
  ~/.claude/skills/Interceptor/Extension/), then retry.
EOF
        exit 10
    fi
    err="$err; shared interceptor daemon was not restarted because this capture does not own its complete process family"
else
    # Non-wedge DOM-render failure (e.g. page disallows injection: chrome://,
    # Web Store, PDF). Try --pixel once as the documented fallback.
    if run_recovery_mode pixel; then
        publish_capture
    fi
fi

# Final guard: distinguish nothing-landed (exit 9) from landed-but-blank (exit 12).
if image_landed; then
    if content_ok; then
        publish_capture
    fi
    cat >&2 <<EOF
Capture.sh: BLANK/DEGENERATE capture (exit 12) — an image landed but is near-uniform
(std-dev < ${MIN_STDDEV}). This is NOT a verified capture. The page most likely has not
hydrated, or uses entrance animations (elements start at opacity:0), so DOM-render
snapped a blank frame. DO NOT treat a blank frame as evidence — this is a wedged
verifier, so defer.
REMEDIATION:
  1. Re-run the same URL with --pixel; a minimized pinned window is leased
     without focus and restored automatically.
  2. Or wait for hydration and re-capture without foregrounding the browser.
  last error: $err
EOF
    exit 12
fi

cat >&2 <<EOF
Capture.sh: FAIL — capture did not succeed after recovery.
  last error: $err
REMEDIATION:
  1. interceptor status            # daemon + bridge health
  2. If browser verbs hang but status/contexts answer: reload the extension.
  3. Re-run Tools/PreflightIsolation.sh and resolve any UUID-rot remediation.
  Never fall back to screencapture/osascript.
EOF
exit 9
