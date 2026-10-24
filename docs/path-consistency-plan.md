# Path Consistency Upgrade

Scope: static configuration, source/style/resource paths, and daily editing verification.
No dependency upgrades, global setting changes, automatic project scans, commits, or publishing.

Final automated revalidation passed after the native/resource directory-cooperation and external-configuration lifecycle fixes. Physical keyboard and user-profile acceptance remain separate, pending checks.

## Delivery Checklist

- [x] One nearest-config rule, bounded by the workspace; same-directory tsconfig wins over jsconfig.
- [x] Direct and inherited `${configDir}` paths/baseUrl agree with TypeScript.
- [x] Track configuration dependencies, including missing and external extends targets.
- [x] Configuration changes invalidate only affected active projects; rebuild on the next request.
- [x] Source/module caches refresh across revisions while sharing IO within a request.
- [x] Static aliases work for linked styles, style src, HTML resources, CSS imports/URLs and JS/TS resource imports.
- [x] Source definitions and resource opening remain separate; resources do not start semantic analysis.
- [x] Resource completion lists only the requested directory and supports directory descent.
- [x] Unfinished import/style strings retain safe completion ranges and do not become complete file links.
- [x] Preserve cancellation, unsaved-buffer support, traversal budgets and URL/dynamic-path boundaries.
- [x] Host tests cover completion acceptance, Emmet fallback/native switching, closing tags and undo.
- [x] Real keybinding/suggestion-window checks are recorded separately from provider/command tests.
- [x] Re-run full unit tests, syntax checks, bundled build and current/minimum VS Code host after the directory-cooperation fix.
- [x] Short synthetic continuous-edit/project-switch/idle-resume check and same-machine resolver benchmark comparison.
- [x] JoyCode availability checked; no executable found, so host compatibility is not verified.
- [x] README support boundaries and manual acceptance checklist updated.
- [ ] Physical Tab/keybinding and automatic suggestion-window acceptance in the user's editor profile.

## Verification Record

Verification date: 2026-10-24. Unit/runtime checks use Node 24.21.0; editor-host checks use each editor's bundled runtime.

- Configuration/resource/style lifecycle targeted tests before the final EOF recovery addition: 71 passed.
- EOF recovery and adjacent template/source/style tests: 43 passed, 4 skipped, 0 failed.
- Final full unit suite: 221 total, 216 passed, 5 skipped (original business fixtures unavailable), 0 failed.
- Syntax checks for source/scripts/unit/host tests and `git diff --check`: passed.
- Bundled CommonJS entry and Vue 2 worker checks: passed.
- Full VS Code 1.141.0 host: passed, including legacy, path and operation acceptance suites.
- Full VS Code 1.90.0 host: passed; this checks the exact declared minimum, not just a later 1.90 patch.
- Path host covers safe/native resource URLs, JS/TS resource imports, actual native folder cooperation and disabled-native fallback, empty directories, mixed source/resource directory descent, unfinished ranges, unsaved styles and no extension semantic startup for resource-only operations.
- Configuration host covers an external inherited config: unsaved changes preserve old mappings, saving/deleting/creating the config releases the affected service, source/image/style mappings agree, and resource refresh does not rebuild semantics.
- Operation host covers actual suggestion acceptance, native/fallback Emmet, command expansion/cursor and completion/import/method/rename/closing undo. An earlier full-run failure exposed a test that left closing tags disabled; the test now restores its original workspace setting.
- Host harness fixes retain all operation assertions: use the editor's own focus-window command when available and assert real focus; wait for both snippet text and the final cursor rather than only the text event. Current and minimum host suites run serially in isolated profiles.
- Short synthetic worker check: 32 unsaved edits, 3 project switches, idle release/resume, 5 workers created and 5 terminated; every completion used the current project's current buffer. This does not prove long-session memory stability in a real project.
- Physical keybinding/automatic-widget checks: pending; see `daily-operation-acceptance.md`. Overall operation acceptance is not complete without those checks.

Authoritative full-run logs for this verification:

- `/tmp/vueclick-upgrade-unit-final-current.log`
- `/tmp/vueclick-upgrade-build-final-current.log`
- `/tmp/vueclick-full-host-current-final.log`
- `/tmp/vueclick-full-host-minimum-final.log`
- `/tmp/vueclick-short-session-current.json`
- `/tmp/vueclick-benchmark-comparison.json`

Resolver benchmark comparison against commit `9764ad2`, using the same locked dependencies and three alternating baseline/current runs after host tests stopped:

| Synthetic measurement | Baseline | Current |
| --- | ---: | ---: |
| 3,000-expression index build median | 17.8012 ms | 18.2605 ms |
| Distributed warm lookup median | 0.0246 ms | 0.0245 ms |
| Alias/barrel cross-file lookup median | 0.7235 ms | 0.7520 ms |
| Request-session cross-file lookup median | 0.5058 ms | 0.5141 ms |
| 60 independent cross-file requests: read/stat calls | 600 / 720 | 600 / 720 |
| 60 request-session cross-file requests: read/stat calls | 360 / 480 | 360 / 480 |

These temporary logs are local evidence, not repository fixtures. The benchmark was rerun after the latest full host tests; it measures resolver APIs, not native completion-provider cooperation. IO counts do not increase in this scenario; small timing differences are descriptive, not a machine-independent performance guarantee. Real-project long-session use and user keybinding conflicts still need separate observation. Worker-check memory samples are parent-plus-workers process RSS, not isolated worker heap measurements or proof of leak freedom.

Unavailable host/UI checks remain explicit.
The existing lockfile's old mirror URLs are a separate installation issue; do not change dependency versions.
