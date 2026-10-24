# Daily Operation Acceptance

Automated editor-host checks and physical keyboard checks are separate evidence.
The extension never changes global Emmet settings or installs a Tab keybinding.

## Automated Host Coverage

Run `npm run test:vscode` in an isolated temporary profile. The suite includes:

- Static aliases in HTML resources, style sources/imports and CSS URLs.
- Static resource imports in standalone JS/TS, resource-only directories and mixed source/resource imports.
- Class-to-style definitions using current unsaved style buffers.
- File/folder path completion, directory descent, and no semantic startup for resource requests.
- Native JS/TS folder cooperation, disabled-native fallback, and mixed source/resource directory descent.
- External inherited configuration save/delete/create, consistent source/image/style refresh, and lazy semantic rebuild.
- Unfinished import/style strings, cursor-limited replacement spans and unchanged following SFC tags.
- Native/fallback Emmet suggestions in template and style contexts.
- Emmet command expansion and the resulting cursor position.
- Acceptance through the suggestion UI for members, deep members and auto imports.
- Undo of completion/auto-import edits, generated methods, semantic rename and automatic closing tags.

`VUECLICK_PATH_TEST_ONLY=1` and `VUECLICK_OPERATION_TEST_ONLY=1` select the targeted subsets.
`type` commands exercise editor text events; `expandAbbreviation` exercises the expansion command.
Neither proves that a physical Tab press selects the intended keybinding.
The harness asserts real window focus and waits for both automatic-closing text and final cursor state. Run editor-host suites serially so separate test windows do not compete for focus.

## Physical Keyboard Checklist

Test the current checkout, not an older installed VSIX. From the repository root, run `npm run build`, then open an Extension Development Host with F5 or `code --new-window --extensionDevelopmentPath="$PWD" /path/to/temporary-workspace`. If `code` is not on PATH, use the editor's executable. Confirm that the development extension is loaded before recording results; user extensions/keybindings can be checked separately from the isolated host suite.

Use a temporary workspace/profile, with these workspace-only preferences if desired:

```json
{
  "emmet.includeLanguages": { "vue": "html" },
  "emmet.triggerExpansionOnTab": true
}
```

- [ ] Type `div` in the template and press physical Tab; verify `<div></div>` and cursor between tags.
- [ ] Type `this.`; verify the suggestion widget appears automatically under the chosen suggestion settings.
- [ ] Type `this.form.` and accept a property using the keyboard.
- [ ] Accept an auto import, then press the actual undo shortcut; verify import and insertion undo together.
- [ ] Switch native/fallback Emmet mapping and check template and style abbreviations.
- [ ] Repeat with suggestions disabled/manual, an unsaved SFC and project switching.
- [ ] Check user/custom keybindings and JoyCode separately; do not infer their result from VS Code command tests.

## Evidence Record

Physical keyboard and automatic-widget checks: pending; no direct local UI control tool is available in this session. Command/event tests must not be reported as physical-key success.
JoyCode: no executable was found in Applications, the user's Applications folder, or PATH in this session; not verified.
Full VS Code 1.141.0 and exact minimum 1.90.0 host suites passed on 2026-10-24; results are recorded in `path-consistency-plan.md`.
The short synthetic worker check covers 32 unsaved edits, project switching and idle release/resume; long-session memory stability in a real Vue 2 project is not established by that check.
Configuration changes apply to saved JSON configuration; unsaved source/SFC/style buffers retain their existing support.
New untitled Vue files retain static/snippet support; project semantic/resource behavior requires a saved file URI.
