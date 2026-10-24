'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

async function runPathConsistency(directory) {
  const root = path.join(directory, 'paths')
  fs.mkdirSync(path.join(root, 'src/assets/nested'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src/styles'), { recursive: true })
  fs.mkdirSync(path.join(root, 'src/views'), { recursive: true })
  fs.writeFileSync(path.join(root, 'jsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@src/*': ['src/*'] } } }))
  const stylesheet = path.join(root, 'src/styles/theme.scss')
  const image = path.join(root, 'src/assets/logo.svg')
  const encodedImage = path.join(root, 'src/views/local image.svg')
  fs.writeFileSync(stylesheet, '.card { color: red }')
  fs.writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  fs.writeFileSync(encodedImage, '<svg/>')
  fs.writeFileSync(path.join(root, 'src/assets/nested/photo.png'), '')
  fs.mkdirSync(path.join(root, 'src/assets/icon-set'))
  const text = '<template><div class="card"/><img src="@src/assets/"/><img src="@src/assets/logo.svg"/>' +
    '<img src="local%20image.svg?version=1"/><a href="#here"/><a href="https://example.com/a"/><a href="command:workbench.action.terminal.new"/></template>\n' +
    '<script>import "@src/styles/"</script>\n' +
    '<style lang="scss" src="@src/styles/theme.scss"/>\n' +
    '<style>@import "@src/styles/theme.scss"; .x { background: url("@src/assets/logo.svg") }</style>'
  const file = path.join(root, 'src/views/Parent.vue')
  fs.writeFileSync(file, text)
  const document = await vscode.workspace.openTextDocument(file)
  const editor = await vscode.window.showTextDocument(document)
  const at = marker => document.positionAt(document.getText().indexOf(marker) + marker.length)
  const state = () => vscode.commands.executeCommand('vueClick.showProjectInfo')
  const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', document.uri, 100)
  assert.ok(links.some(link => link.target?.fsPath === stylesheet), 'style src/import aliases must resolve to the stylesheet')
  assert.ok(links.some(link => link.target?.fsPath === image), 'HTML and CSS image aliases must resolve to the image')
  assert.ok(links.some(link => link.target?.fsPath === encodedImage), 'ordinary encoded resource URLs must keep native file URL handling')
  assert.ok(links.some(link => link.target?.scheme === 'https'))
  assert.ok(!links.some(link => link.target?.scheme === 'command'))
  assert.ok(!links.some(link => link.target?.fsPath.includes('/views/@src/')), 'aliases must not become relative URL paths')
  assert.equal((await state()).state, 'not-started', 'resource link resolution must not start semantics')
  await vscode.extensions.getExtension('vscode.typescript-language-features')?.activate()
  for (const extension of ['js', 'ts']) {
    const sourceFile = path.join(root, 'src/views/Resources.' + extension)
    fs.writeFileSync(sourceFile, 'import "@src/styles/theme.scss";\nimport "@src/styles/";\nimport "@src/assets/";\nimport "@/assets/";\nimport "@src/assets/icon-"')
    const source = await vscode.workspace.openTextDocument(sourceFile)
    await vscode.window.showTextDocument(source)
    const sourceLinks = await vscode.commands.executeCommand('vscode.executeLinkProvider', source.uri, 100)
    assert.ok(sourceLinks.some(link => link.target?.fsPath === stylesheet), 'standalone ' + extension + ' resource imports share alias links')
    const position = source.positionAt(source.getText().indexOf('import "@src/styles/"') + 'import "@src/styles/'.length)
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', source.uri, position)
    assert.equal(list.items.filter(item => item.label === 'theme.scss').length, 1, 'standalone ' + extension + ' resource imports offer the asset once')
    const folderPosition = source.positionAt(source.getText().indexOf('import "@src/assets/"') + 'import "@src/assets/'.length)
    const folders = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', source.uri, folderPosition)
    assert.equal(folders.items.filter(item => String(item.label).replace(/\/$/, '') === 'nested').length, 1,
      'standalone ' + extension + ' keeps one resource directory candidate: ' + folders.items.map(item => item.label).join(', '))
    const triggered = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', source.uri, folderPosition, '/')
    assert.equal(triggered.items.filter(item => String(item.label).replace(/\/$/, '') === 'nested').length, 1, 'slash-triggered directory completion must not duplicate')
    const hyphenPosition = source.positionAt(source.getText().indexOf('import "@src/assets/icon-"') + 'import "@src/assets/icon-'.length)
    const hyphen = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', source.uri, hyphenPosition, '-')
    assert.equal(hyphen.items.filter(item => String(item.label).replace(/\/$/, '') === 'icon-set').length, 1, 'extension-only trigger characters must retain resource folders')
    const fallbackPosition = source.positionAt(source.getText().indexOf('import "@/assets/"') + 'import "@/assets/'.length)
    const fallback = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', source.uri, fallbackPosition)
    assert.equal(fallback.items.filter(item => String(item.label).replace(/\/$/, '') === 'nested').length, 1,
      'extension-only src fallback directories remain available with native paths enabled')
    const settings = vscode.workspace.getConfiguration(extension === 'ts' ? 'typescript' : 'javascript', source.uri)
    const previousPaths = settings.inspect('suggest.paths')?.workspaceValue
    try {
      await settings.update('suggest.paths', false, vscode.ConfigurationTarget.Workspace)
      const manual = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', source.uri, folderPosition)
      assert.equal(manual.items.filter(item => String(item.label).replace(/\/$/, '') === 'nested').length, 1,
        'resource directory fallback remains available with native paths disabled')
    } finally {
      await settings.update('suggest.paths', previousPaths, vscode.ConfigurationTarget.Workspace)
    }
    assert.equal((await state()).state, 'not-started', 'standalone resource imports must not start extension semantics')
  }
  await vscode.window.showTextDocument(document)
  const hits = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, at('class="ca'))
  assert.ok(hits.some(hit => hit.uri.fsPath === stylesheet))
  const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at('src="@src/assets/'))
  const labels = completion.items.map(item => typeof item.label === 'string' ? item.label : item.label.label)
  assert.ok(labels.includes('logo.svg'))
  assert.ok(labels.includes('nested/'))
  const scriptPaths = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at('import "@src/styles/'))
  assert.ok(scriptPaths.items.some(item => item.label === 'theme.scss'), 'static script style imports must offer resource files before an extension is typed')
  assert.equal((await state()).state, 'not-started', 'resource path completion must not start semantics')
  fs.mkdirSync(path.join(root, 'src/styles/empty'))
  const emptyFile = path.join(root, 'src/views/Empty.vue')
  const emptyText = '<script>import "@src/styles/empty/"</script>'
  fs.writeFileSync(emptyFile, emptyText)
  const emptyDocument = await vscode.workspace.openTextDocument(emptyFile)
  await vscode.window.showTextDocument(emptyDocument)
  const emptyList = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', emptyDocument.uri,
    emptyDocument.positionAt(emptyText.indexOf('@src/styles/empty/') + '@src/styles/empty/'.length))
  assert.equal((await state()).state, 'not-started', 'an empty resource directory must not fall through into semantic startup')
  assert.equal(emptyList.items.filter(item => [vscode.CompletionItemKind.File, vscode.CompletionItemKind.Folder].includes(item.kind)).length, 0,
    'an empty resource directory must not invent file/folder candidates; native word suggestions remain editor-owned')
  await vscode.window.showTextDocument(document)
  const folder = completion.items.find(item => item.label === 'nested/')
  assert.equal(folder.kind, vscode.CompletionItemKind.Folder)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(document.uri, folder.range, typeof folder.insertText === 'string' ? folder.insertText : folder.insertText.value)
  await vscode.workspace.applyEdit(edit)
  const nested = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at('src="@src/assets/nested/'))
  assert.ok(nested.items.some(item => item.label === 'photo.png'))
  const external = await vscode.workspace.openTextDocument(stylesheet)
  const unsaved = new vscode.WorkspaceEdit()
  unsaved.insert(external.uri, new vscode.Position(0, 0), '\n\n')
  await vscode.workspace.applyEdit(unsaved)
  await vscode.window.showTextDocument(document)
  const refreshed = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, at('class="ca'))
  assert.ok(refreshed.some(hit => hit.uri.fsPath === stylesheet && hit.range.start.line === 2))
  assert.equal((await state()).state, 'not-started')
  editor.selection = new vscode.Selection(at('class="ca'), at('class="ca'))

  async function replace(source) {
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source)
    assert.equal(await vscode.workspace.applyEdit(edit), true)
  }
  for (const source of [
    '<style lang="scss" src="@src/styles/',
    '<script>import "@src/styles/</script><template><div/></template>',
    '<style>@import "@src/styles/</style><template><div/></template>'
  ]) {
    await replace(source)
    const position = at('@src/styles/')
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position)
    const item = list.items.find(item => item.label === 'theme.scss')
    assert.ok(item, 'unfinished resource strings must retain path completion: ' + source)
    assert.equal(document.offsetAt(item.range.end), document.offsetAt(position), 'completion must stop at the cursor')
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, item.range, item.insertText)
    assert.equal(await vscode.workspace.applyEdit(edit), true)
    assert.equal(document.getText(), source.replace('@src/styles/', '@src/styles/theme.scss'))
    const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', document.uri, 100)
    assert.equal(links.length, 0, 'unfinished strings must not become complete file links')
    assert.equal((await state()).state, 'not-started')
  }

  fs.mkdirSync(path.join(root, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/modules/helper.ts'), 'export const value = 1')
  fs.writeFileSync(path.join(root, 'src/modules/theme.scss'), '.mixed {}')
  fs.mkdirSync(path.join(root, 'src/modules/nested'))
  fs.writeFileSync(path.join(root, 'src/modules/nested/inside.ts'), 'export const inside = 1')
  await replace('<script>import "@src/modules/"</script>')
  const mixed = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at('@src/modules/'))
  assert.ok(mixed.items.some(item => item.label === 'helper'), 'source import paths retain native extensionless completions')
  assert.equal(mixed.items.find(item => item.label === 'helper').kind, vscode.CompletionItemKind.File)
  assert.ok(!mixed.items.some(item => item.label === 'helper.ts'), 'resource completion must not insert an explicit TypeScript extension')
  assert.ok(mixed.items.some(item => item.label === 'theme.scss'), 'mixed source/resource directories retain resource completions')
  const mixedFolder = mixed.items.find(item => String(item.label).replace(/\/$/, '') === 'nested')
  assert.equal(mixedFolder?.kind, vscode.CompletionItemKind.Folder, 'native source directory candidates must remain real folders')
  assert.equal(mixedFolder.insertText, 'nested/')
  assert.equal(mixedFolder.command?.command, 'editor.action.triggerSuggest')
  const descend = new vscode.WorkspaceEdit()
  descend.replace(document.uri, mixedFolder.range, mixedFolder.insertText)
  assert.equal(await vscode.workspace.applyEdit(descend), true)
  assert.equal(document.getText(), '<script>import "@src/modules/nested/"</script>')
  const inside = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at('@src/modules/nested/'))
  assert.ok(inside.items.some(item => item.label === 'inside' && item.kind === vscode.CompletionItemKind.File))
  await require('./configuration-reload').runConfigurationReload(directory)
  console.log('Path consistency checks passed: alias links, style definitions, directory descent, unfinished strings, source/resource imports, unsaved styles, no resource semantic startup')
}

module.exports = { runPathConsistency }
