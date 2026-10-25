'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

async function runReadOnly(directory) {
  const root = path.join(directory, 'read-only')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"vueclick-read-only-fixture","private":true}')
  fs.writeFileSync(path.join(root, 'helper.js'), `/** Save an invoice. */
export function save(value) { return value }`)
  const js = `import { save } from './helper';\n\nsave(1)`
  const vue = `<template><div /></template><script>
/**
 * @param {string} orderId Invoice identifier.
 */
const save = (orderId) => { return orderId }
export default { methods: { run() { return save('42') } } }
</script>`
  for (const [name, text, marker, expected] of [
    ['Page.js', js, 'save(1)', /Save an invoice/],
    ['Page.vue', vue, 'return orderId', /orderId: string/]
  ]) {
    const file = path.join(root, name)
    fs.writeFileSync(file, text)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    const offset = text.indexOf(marker) + (name.endsWith('.vue') ? 'return '.length + 1 : 1)
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, document.positionAt(offset))
    assert.match(hover.flatMap(value => value.contents).map(value => value.value || value).join('\n'), expected)
    const own = hover.find(value => value.contents.some(content => expected.test(content.value || String(content))))
    assert.ok(own?.range?.contains(document.positionAt(offset)), 'hover range must contain the queried reference')
    const info = await vscode.commands.executeCommand('vueClick.showProjectInfo')
    assert.equal(info.state, 'not-started', 'static JSDoc hover must not start the project worker')
  }
  fs.writeFileSync(path.join(root, 'jsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { '@style/*': ['./*'] } }
  }))
  const picture = path.join(root, 'right-jump.png')
  fs.writeFileSync(picture, '')
  for (const language of ['css', 'scss', 'less']) {
    const theme = path.join(root, 'theme.' + language)
    fs.writeFileSync(theme, '.theme {}')
    const text = `@import "@style/theme.${language}";\n.card { background: url("./right-jump.png"); }\n@import "@style/the`
    const file = path.join(root, 'Page.' + language)
    fs.writeFileSync(file, text)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    assert.equal(document.languageId, language)
    for (const [marker, target] of [['@style/theme', theme], ['./right-jump', picture]]) {
      const position = document.positionAt(text.indexOf(marker) + 3)
      const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position)
      assert.ok(definitions.some(value => (value.uri || value.targetUri)?.fsPath === target),
        language + ' must resolve ' + marker)
    }
    const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', document.uri, 100)
    assert.ok(links.some(value => value.target?.fsPath === theme), language + ' must resolve alias links')
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
      document.uri, document.positionAt(text.length))
    assert.ok(completions.items.some(value => value.label === 'theme.' + language && value.detail === 'VueClick style resource'),
      language + ' must complete an unfinished alias path')
    const info = await vscode.commands.executeCommand('vueClick.showProjectInfo')
    assert.equal(info.state, 'not-started', 'style resources must not start the project worker')
  }
  console.log('Read-only hover and standalone style API checks passed on VS Code ' + vscode.version +
    '; keyboard, suggestion UI and focus-dependent operation tests were not run in this mode.')
}

module.exports = { runReadOnly }
