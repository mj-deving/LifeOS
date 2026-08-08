# Linux and Flatpak Gotchas

All four failures below surfaced in one session on Fedora with Chrome installed as
a Flatpak (`com.google.Chrome`), reached through a `~/.local/bin/google-chrome` shim
that adds `--filesystem=/tmp --filesystem=home --die-with-parent`. Read this file
before debugging a Linux install; the first symptom looks like a dead extension and
is not. *(public PR #1682, @pkumaschow.)*

- **A daemon socket created INSIDE a Flatpak sandbox is not connectable from the
  host CLI, even though the socket file is plainly visible.** `/tmp` is genuinely
  shared both directions (a host-written marker reads inside the sandbox and vice
  versa), so `ls -la /tmp/interceptor.sock` shows the file — and `interceptor
  status` reports `daemon: not running` in the same second. The endpoint lives in
  the sandbox's namespace; the visible file is a shadow. **The fix is a
  non-sandboxed browser**, not a Flatpak permission tweak. Native Vivaldi is one
  Interceptor supports; its relay's socket is host-accessible and the CLI connects
  immediately. Copy the NMH manifest to that browser's own dir first
  (e.g. `~/.config/vivaldi/NativeMessagingHosts/`).
- **A windowless orphaned Flatpak instance can hold port 19222 invisibly, and
  `pkill` on the PID you can see does not clear it.** The operator sees no Chrome
  window and reasonably reports "no Chrome is open" while
  `bwrap --args N -- chrome --profile-directory=X` is still alive with its daemon
  owning the port, starving every relay that starts afterwards — including a
  different browser's. `kill <pid>` on the visible child does not propagate
  through `bwrap`. **`flatpak kill com.google.Chrome` is the reliable clear.**
  Check for this whenever a relay reports the port held but no browser is visibly
  running.
- **The relay only attaches to a singleton it spawned itself; a losing duplicate
  unlinks the winner's socket on exit.** The log signature is `spawning detached
  standalone daemon` → `ws port 19222 already held ... exiting this duplicate` →
  `detached standalone daemon did not become ready before timeout` → `falling back
  to in-process singleton` → `exiting so the existing daemon serves everyone`. It
  never falls back to connecting as a plain ws client. Consequence: **CLI calls are
  self-destructive while another daemon owns the port** — each one auto-spawns a
  duplicate that deletes the live socket, so diagnosing the problem re-causes it.
  If the socket keeps vanishing, stop running CLI commands and fix ownership first.
  (Upstream-worthy: a daemon should never unlink a socket it did not create.)
- **`--load-extension` is dead (Chrome 137+; confirmed ignored on 150).** The
  profile comes up carrying only the five default component extensions. The
  `chrome://extensions` → Load unpacked picker is the only route — and in a Flatpak
  browser it goes through the XDG Document Portal, so the chosen path appears as
  `/run/flatpak/doc/<id>/...` in any error. That prefix is normal and is not the
  fault. **`~/.claude` is a dotfolder and GTK pickers hide dotfiles: press Ctrl+H
  in the picker** or the operator cannot navigate to the extension at all.

**Agent-side footgun from the same session:** `pkill -f interceptor-daemon` run
from Bash matches the invoking shell's own command line and kills it — the command
dies at exit 144 with truncated output, which reads like a wedge. Split the literal
(`PAT="intercep""tor-daemon"; pkill -f "$PAT"`) or kill by PID.
