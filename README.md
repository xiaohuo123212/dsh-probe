# dsh-probe

A **temporary instrumentation workbench** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It turns "add a print, run it, look at the output, delete it" into a stateful loop with a baseline, a gate, and a ledger: 9 tools plus a runtime skill, exposed to the model as a normal DSH plugin.

```text
begin → status → insert / script → run → clean → guard → report
```

The point is not to make the model print better. It is to make a temporary probe **provable**: provable that it sits where you meant, provable that it ran, provable that it was removed byte-for-byte, and provable that the answer survived the probe.

## Why it exists

Three failure modes, all of them silent:

- **Inserted in the wrong place.** Hand-placed prints land in the wrong overload, the wrong indent, or the wrong comment syntax — and a probe that reports a plausible wrong value is worse than no probe.
- **Never runs the same way twice.** Scratch scripts scatter across `/tmp`, the repo root, and random `node -e` invocations, with no record of the command, the arguments, or the exit code.
- **Never fully removed.** Remembering to delete is not a mechanism. `console.log("here")` ships, and nothing can prove that everything else was restored.

There is a fourth, more expensive one: **the answer is lost**. Probes get deleted by design, so a conclusion that only lived in a probe is gone — and the same experiment gets run again, or a hypothesis that was already refuted gets trusted again.

## Requirements

- DeepSeek Harness (Desktop, or a CLI with a profile)
- Node.js >= 20
- A profile directory that has been booted at least once

## Install

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1 -Profile desktop
```

By default the script packs this checkout into `%USERPROFILE%\.dsh\plugins\dsh-probe\dsh-probe-<version>.tgz` and points the profile at that copy, so **moving or deleting the checkout cannot break the profile**. Re-run the script after editing the plugin to repack and upgrade; it is idempotent.

| Flag | Effect |
|---|---|
| `-Profile <name>` | target profile (default `desktop`, or `$env:DSH_PROFILE`) |
| `-Mode link` | profile depends directly on this checkout — live edits without reinstalling, but the directory must stay put |
| `-Check` | print the current wiring and exit; exit code 2 means a broken link or a missing tarball |
| `-Uninstall` | remove the dependency, the bundles entry, and the packed copies |
| `-DryRun` | preview without writing anything |

Uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1 -Uninstall
```

Switching an existing `link:` install to the packed one is automatic: the script removes the old dependency, deletes the stale junction (the link itself, never its target), and installs the tarball — no manual cleanup. Repacking is content-aware too: pnpm pins a `file:` tarball by path and integrity, so a repacked tarball at the same path would otherwise be ignored as "already up to date"; the script compares the new tarball's SHA-256 against `.dsh/plugins/dsh-probe/packed.sha256` and forces a replace when the bytes moved. `-Check` is the answer to "did moving the folder break it?" — it works from any directory and tells you which mode the profile is in.

## Quickstart

```text
# 1. write down the question (optional: the first probe_* call creates .probe/ lazily)
probe_begin goal="why does hp go negative on frame 3" label=hp

# 2. instrument: one line of source, or a throwaway script
probe_insert file=src/game.js anchor="state.hp -= 1" code='console.log("[probe]", "hp", state.hp)'
probe_script action=new name=repro runtime=node

# 3. run it, read the [probe] lines, edit, run again
probe_run command=["node", "repro.mjs"]

# 4. tear down and prove the worktree is clean
probe_clean
probe_guard scope=staged

# 5. keep the answer, not the probes
probe_report question="hp goes negative on frame 3" verdict=explained findings="hp = -1 after the third tick"
```

A non-zero exit code from `probe_run` is data, not an error; exit code 124 means the timeout killed the process tree. `probe_clean dryRun=true` shows the teardown plan without touching anything. `probe_status` shows what is hanging right now — run it before adding the next probe and again before cleaning up.

## Tools

| Tool | What it does |
|---|---|
| `probe_begin` | Records the goal for the current session. Not mandatory — the first `probe_*` call in a workspace lazily initialises `.probe/` — but a probe without a question teaches you nothing. Re-calling it adopts the same session; `reset=true` starts a new round. |
| `probe_status` | Read-only snapshot: probes still hanging (file and line ranges), scripts, runs, ledger size, and whether the session record and the files still agree. |
| `probe_insert` | Inserts a marked probe block at a unique `anchor` or 1-based `line`, and saves the file's baseline. |
| `probe_script` | Manages throwaway scripts under `.probe/scripts/`: `new` / `list` / `show` / `rm`, node, python, or powershell. |
| `probe_run` | Runs one command or one registered script; returns exit code, wall time, `[probe]` lines, and a run record. |
| `probe_clean` | Removes every marked block against the baseline, deletes throwaway scripts, re-scans for residue. |
| `probe_guard` | Scans `worktree`, `staged`, or `all` for leftover markers and reports `file:line`. Run before every commit. |
| `probe_report` | Appends the question, method, finding, and verdict to `PROBE.md` and `.probe/ledger.json`. |
| `probe_guide` | Returns the playbook: `workflow`, `markers`, `scripts`, `run`, `clean`, `guard`, `pitfalls`, `languages`, `all`. |

## Storage layout

```text
<project>/
  PROBE.md                     # ledger, human-readable; survives probe_clean
  .probe/
    session.json               # the only state file
    baseline/<path with __>    # pre-probe copies of instrumented files
    scripts/<name>.<ext>       # throwaway verification scripts
    runs/<ts>-<slug>.json      # one record per probe_run
    tmp/
    ledger.json                # ledger, structured
```

Add `.probe/` to `.gitignore` — `probe_guard` warns if the directory is tracked by git. The plugin's own `.gitignore` already ignores it.

## Conventions

- **`[probe]` output prefix.** `probe_run` extracts those lines and shows them first; everything else stays in the run record. Node: `console.log("[probe]", ...)`, Python: `print("[probe] ...")`, PowerShell: `Write-Output "[probe] ..."`. A leading `PROBE|` is accepted as an alias, case-insensitively.
- **Marker payload.** Each block is wrapped in two comment lines carrying `>>> dsh-probe begin <id> [label]` and `<<< dsh-probe end <id>`, with the comment syntax chosen per language. Ids are assigned by the plugin and are never written by hand.
- **Ids.** Probes are `p1`, `p2`, …; runs are `r1`, `r2`, …; ledger entries are `Q-1`, `Q-2`, …; sessions are `pr-YYYYMMDD-HHMMSS`.
- **Optional `probe.json`** at the project root overrides `dataDir`, `ledgerFile`, `defaultTimeoutSec`, `maxOutputBytes`, `maxScanBytes`, `maxRuns`, and `exclude`.

## Development

No dependencies, no build step: plain ESM against `node:` built-ins.

```bash
npm test                                  # all suites via the built-in test runner
node test/integration.test.mjs            # one suite, in-process
```

Inside a file-sandboxed agent, piped stdio is blocked, so the test runner cannot spawn its per-file workers and `npm test` dies with `spawn EPERM` before any assertion runs. Use:

```bash
node --test --test-isolation=none test/markers.test.mjs test/runner.test.mjs \
  test/guard.test.mjs test/integration.test.mjs test/package.test.mjs
```

While iterating on the plugin itself, `install.ps1 -Mode link` makes every edit live and skips the repack step; switch back to the default packed install before you move the checkout.

`lib/runner.js` has the same constraint in mind: when pipes are denied it captures child output through temporary files instead, so `probe_run` keeps working. Tests never write into the checkout — every case builds its own project under `os.tmpdir()`.

## Learn more

- Design rationale, mechanisms, and known limits: [docs/DESIGN.md](docs/DESIGN.md)
- Runtime playbook: `probe_guide section=pitfalls`, `probe_guide section=languages`
- Implementation contract: [CONTRACT.md](CONTRACT.md)

## License

Apache-2.0 — see [LICENSE](LICENSE).
