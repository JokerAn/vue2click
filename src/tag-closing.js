'use strict'

function registerTagClosing(vscode, context, documentIndex, embedded) {
  let pending
  function clear(request = pending) {
    if (!request) {
      return
    }
    clearTimeout(request.timer)
    clearTimeout(request.expiry)
    if (pending === request) {
      pending = undefined
    }
  }
  async function complete(request) {
    if (pending !== request) {
      return
    }
    const { document, editor, version, offset } = request
    if (document.isClosed || document.version !== version || vscode.window.activeTextEditor !== editor) {
      clear(request)
      return
    }
    if (editor.selections.length !== 1 || !editor.selection.isEmpty ||
      document.offsetAt(editor.selection.active) !== offset) {
      return
    }
    clear(request)
    const index = documentIndex(document)
    const position = document.positionAt(offset)
    const entry = embedded.at(document, index, position)
    if (entry?.language !== 'html') {
      return
    }
    const snippet = entry.service.doTagComplete(entry.document, position, entry.parsed)
    if (!snippet || document.getText().slice(offset).startsWith(snippet.replace('$0', ''))) {
      return
    }
    try {
      await editor.insertSnippet(new vscode.SnippetString(snippet), position, { undoStopBefore: false, undoStopAfter: false })
    } catch (error) {
      console.error('[Vue2Click] Tag closing:', error)
    }
  }
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    const document = event.document
    if (!event.contentChanges.length) {
      return
    }
    if (pending?.document === document) {
      clear()
    }
    const editor = vscode.window.activeTextEditor
    const change = event.contentChanges?.[0]
    if (document.languageId !== 'vue' || editor?.document !== document || event.reason ||
      event.contentChanges.length !== 1 || change.rangeLength !== 0 || !['>', '/'].includes(change.text) ||
      !vscode.workspace.getConfiguration('vueClick', document.uri).get('autoClosingTags.enabled', true) ||
      !vscode.workspace.getConfiguration('html', document.uri).get('autoClosingTags', true)) {
      return
    }
    clear()
    const request = { document, editor, version: document.version, offset: document.offsetAt(change.range.start) + 1 }
    pending = request
    request.timer = setTimeout(() => complete(request), 0)
    request.expiry = setTimeout(() => clear(request), 1000)
  }))
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    const request = pending
    if (!request || event.textEditor !== request.editor) {
      return
    }
    if (event.selections.length !== 1 || !event.selections[0].isEmpty ||
      request.document.offsetAt(event.selections[0].active) !== request.offset) {
      clear(request)
      return
    }
    complete(request)
  }), vscode.window.onDidChangeActiveTextEditor(() => clear()), { dispose() { clear() } })
}

module.exports = { registerTagClosing }
