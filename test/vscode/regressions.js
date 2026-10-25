'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

async function runRegressions(directory) {
  const root = path.join(directory, 'regressions')
  fs.mkdirSync(root)
  const child = '<script>export default { props: { count: Number, mode: { type: String, validator: value => ["edit", "view"].includes(value) } }, emits: ["saved"] }</script>'
  fs.writeFileSync(path.join(root, 'Child.vue'), child)
  fs.writeFileSync(path.join(root, 'jsconfig.json'), '{"compilerOptions":{"allowJs":true,"types":[]}}')
  for (const [index, expression] of ['count > 0', 'count < 5', 'count >= 0 && count <= 5'].entries()) {
    const text = `<template><Child :count="${expression}" mode="" @sa /></template><script>
import Child from './Child.vue'; export default { components: { Child }, data() { return { count: 1 } } }</script>`
    const file = path.join(root, `Comparison${index}.vue`)
    fs.writeFileSync(file, text)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    for (const [marker, expected] of [['mode="', 'edit'], ['@sa', 'saved']]) {
      const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
        document.uri, document.positionAt(text.indexOf(marker) + marker.length))
      assert.ok(result.items.some(item => item.label === expected), expression + ': ' + marker)
    }
  }

  await vscode.extensions.getExtension('vscode.typescript-language-features')?.activate()
  const folderCounts = []
  for (let index = 0; index < 18; index++) {
    const project = path.join(root, 'paths' + index)
    fs.mkdirSync(path.join(project, 'src/assets/nested'), { recursive: true })
    fs.mkdirSync(path.join(project, 'src/views'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src/assets/logo.svg'), '<svg/>')
    fs.writeFileSync(path.join(project, 'src/model.js'), 'export const model = { nativeReady: 1 }')
    fs.writeFileSync(path.join(project, 'jsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '@src/*': ['src/*'] } }
    }))
    const text = 'import { model } from "@src/model"; model.nativeReady;\nimport "@src/assets/"'
    const file = path.join(project, 'src/views/Resource.' + (index % 2 ? 'ts' : 'js'))
    fs.writeFileSync(file, text)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    const position = document.positionAt(text.length - 1)
    // Wait for this project's native aliases, not just extension activation.
    let nativeReady = false
    const deadline = Date.now() + 10000
    while (!nativeReady && Date.now() < deadline) {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
        document.uri, document.positionAt(text.indexOf('model.nativeReady') + 'model.'.length))
      nativeReady = list.items.some(item => item.label === 'nativeReady')
      if (!nativeReady) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    assert.ok(nativeReady, 'native alias configuration must be ready in project ' + index)
    for (const trigger of [undefined, '/', '-']) {
      const results = await Promise.all([0, 1].map(() =>
        vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position, trigger)))
      for (const result of results) {
        const folders = result.items.filter(item => item.kind === vscode.CompletionItemKind.Folder &&
          String(item.label).replace(/\/$/, '') === 'nested')
        assert.equal(folders.length, 1, `${document.languageId}, project ${index}, trigger ${trigger}`)
        assert.ok(result.items.some(item => item.label === 'logo.svg'), 'resource files remain available with native folders')
        folderCounts.push(folders.length)
      }
    }
  }
  console.log('Regression checks passed: comparison value/event completions; ' +
    folderCounts.length + ' concurrent JS/TS directory requests across 18 newly opened projects without missing or duplicate candidates')
}

module.exports = { runRegressions }
