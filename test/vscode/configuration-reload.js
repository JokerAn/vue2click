'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vscode = require('vscode')

async function runConfigurationReload(directory) {
  const root = path.join(directory, 'config-reload')
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-host-config-'))
  const base = path.join(external, 'base.json')
  const configuration = target => JSON.stringify({ compilerOptions: { paths: { '@cfg/*': [path.join(root, target, '*')] } } })
  try {
    for (const target of ['old', 'new']) {
      fs.mkdirSync(path.join(root, target), { recursive: true })
      fs.writeFileSync(path.join(root, target, 'model.js'), `export const model = { ${target}Field: 1 }`)
      fs.writeFileSync(path.join(root, target, 'theme.scss'), '.card { color: red }')
      fs.writeFileSync(path.join(root, target, 'logo.svg'), '<svg/>')
    }
    fs.writeFileSync(base, configuration('old'))
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ extends: base,
      compilerOptions: { allowJs: true, checkJs: true, types: [] }, include: ['*.vue', '**/*.js'] }))
    const file = path.join(root, 'Reload.vue')
    const text = '<template><img src="@cfg/logo.svg"/><div class="card"/></template>\n' +
      '<script>import { model } from "@cfg/model"; model.</script>\n<style src="@cfg/theme.scss"/>'
    fs.writeFileSync(file, text)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    assert.equal(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(base)), undefined, 'inherited config must be outside the workspace')
    const at = marker => document.positionAt(text.indexOf(marker) + marker.length)
    const state = () => vscode.commands.executeCommand('vueClick.showProjectInfo')
    async function release(message) {
      const deadline = Date.now() + 8000
      while ((await state()).state !== 'not-started' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      assert.equal((await state()).state, 'not-started', message)
    }
    async function members() {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, at('; model.'))
      return list.items.map(item => typeof item.label === 'string' ? item.label : item.label.label)
    }
    async function resources(target) {
      const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', document.uri, 100)
      for (const name of ['logo.svg', 'theme.scss']) {
        assert.ok(links.some(link => link.target?.fsPath === path.join(root, target, name)), 'resource mapping must use ' + target + ': ' + name)
      }
      const styles = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, at('class="ca'))
      assert.ok(styles.some(hit => hit.uri.fsPath === path.join(root, target, 'theme.scss')))
    }
    async function source(target) {
      const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, at('import { mo'))
      assert.ok(definitions.some(hit => hit.uri.fsPath === path.join(root, target, 'model.js')), 'source mapping must use ' + target)
      const labels = await members()
      assert.ok(labels.includes(target + 'Field'))
      assert.ok(!labels.includes((target === 'old' ? 'new' : 'old') + 'Field'))
    }
    await resources('old')
    assert.equal((await state()).state, 'not-started')
    await source('old')
    assert.equal((await state()).state, 'ready')

    const configDocument = await vscode.workspace.openTextDocument(base)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(configDocument.uri, new vscode.Range(configDocument.positionAt(0), configDocument.positionAt(configDocument.getText().length)), configuration('new'))
    assert.equal(await vscode.workspace.applyEdit(edit), true)
    assert.equal(configDocument.isDirty, true)
    await resources('old')
    await source('old')
    assert.equal(await configDocument.save(), true)
    await release('saving an external inherited config must release the active service without an explicit restart')
    await resources('new')
    assert.equal((await state()).state, 'not-started', 'resource refresh must not rebuild semantics')
    await source('new')

    fs.unlinkSync(base)
    await release('deleting an external inherited config must release the active service')
    const missing = await members()
    assert.ok(!missing.includes('oldField') && !missing.includes('newField'), 'missing configuration must not retain stale aliases')
    assert.equal((await state()).state, 'ready')
    fs.writeFileSync(base, configuration('old'))
    await release('creating a previously missing inherited config must release only the affected service')
    await resources('old')
    assert.equal((await state()).state, 'not-started')
    await source('old')
    console.log('Configuration reload checks passed: external saved/unsaved config, deletion/creation, source/resource agreement, lazy semantic rebuild')
  } finally {
    fs.rmSync(external, { recursive: true, force: true })
  }
}

module.exports = { runConfigurationReload }
