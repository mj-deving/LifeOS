# ReplayFlow Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the ReplayFlow workflow in the Interceptor skill to replay a recorded flow"}' \
  > /dev/null 2>&1 &
```

Running **ReplayFlow** in **Interceptor**...

---

Replay a previously recorded user flow to verify it still works after a deploy or code change. Executes the plan script step-by-step, captures the result at each stage, and reports any regressions.

## Preflight Isolation Gate (MANDATORY first step)

```bash
source ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env
bash ~/.claude/skills/Interceptor/Tools/PreflightIsolation.sh
```

Non-zero exit → STOP and surface the message verbatim. Do not fall back to the Default profile. Every `interceptor` verb below — including the `batch` example — passes `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` (from `preferences.env`). Screenshots go through `Tools/Capture.sh`, never raw `interceptor screenshot`.

## When to Use

- After deploying changes to a page that has a recorded flow
- As a regression check before merging UI changes
- To verify a bug fix by replaying the flow that exposed the bug
- As part of a deploy verification pipeline alongside VerifyDeploy

## Steps

### 1. Locate the Flow Plan

Reusable publish-clean examples may live in `skills/Interceptor/Flows/`; project-specific plans live with their owning project's tests or evidence. List shared examples with:

```bash
ls ~/.claude/skills/Interceptor/Flows/
```

Or regenerate from a monitor session:

```bash
interceptor monitor export <SESSION_ID> --plan --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

### 2. Open the Starting URL

The plan script starts with a `interceptor tab new "<url>"` or `interceptor navigate "<url>"` command. Execute it:

```bash
interceptor open "<START_URL>" --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

### 3. Execute the Plan Step-by-Step

Read the plan file and execute each command sequentially. For each action:

```bash
# Example: click a button
interceptor act "button:Sign In" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Example: type into a field
interceptor act "textbox:Email" "user@example.com" --context "$INTERCEPTOR_TEST_CONTEXT_ID"

# Example: wait for page update
interceptor wait-stable --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

After each action that triggers a page change, verify the expected state:

```bash
interceptor read --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

Check that the expected content appears. If an element is missing or content differs from expectations, flag it as a regression.

### 4. Verify Network Contracts (Optional)

If the plan includes commented network cues (`# correlated fetch GET /api/...`), verify those endpoints still fire:

```bash
interceptor net log --json --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

Compare against the baseline network log from the original recording. Look for:
- Endpoints that no longer fire (removed API calls)
- Changed response status codes
- New unexpected requests

### 5. Capture Final State

```bash
bash ~/.claude/skills/Interceptor/Tools/Capture.sh --current
```

Read the printed image path and compare the final screenshot against the expected end state of the flow.

### 6. Report Results

For each step in the plan, report:
- PASS: action succeeded, expected state confirmed
- FAIL: action failed or unexpected state detected
- REGRESSION: behavior changed from baseline

## Batch Safety Gate

Sequential `interceptor act` plus explicit state reads is the default. Treat `batch` as unavailable until a focused smoke probe proves the installed runtime's accepted action names, context/group isolation, per-step failure reporting, and non-zero process exit on failure. Never infer success from the batch command's top-level exit or wrapper `success`; inspect every sub-result and assert the final URL/DOM state. If any falsifier fails, replay sequentially and report the batch runtime gate.

## Notes

- Semantic selectors (`role:name`) are more resilient than ref IDs (`e5`) — prefer them in flow plans.
- If a selector fails, use `interceptor find "<name>"` to locate the element under its new name.
- Flows recorded on one environment may need URL adjustments for another (staging vs production).
- For flows with password fields, the plan will have `# TODO` comments — substitute values before replay.
- Screenshots from replays can be compared against baseline screenshots for visual regression detection.
