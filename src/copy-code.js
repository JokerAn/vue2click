'use strict'

function registerCopyCode(vscode, context) {
  for (const [command, relative] of [
    ['vueClick.copyCodeWithAbsolutePath', false],
    ['vueClick.copyCodeWithRelativePath', true]
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async uri => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.document.uri.scheme !== 'file' || editor.selection.isEmpty) {
        return
      }
      const { document, selection } = editor
      if (uri && uri.toString() !== document.uri.toString()) {
        return
      }
      const filePath = relative
        ? vscode.workspace.asRelativePath(document.uri, false)
        : document.uri.fsPath
      const { start, end } = selection
      const location = `${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}`
      const text = `${filePath.replace(/\\/g, '/')}:${location} ${document.getText(selection)}`
      await vscode.env.clipboard.writeText(text)
    }))
  }
}

module.exports = { registerCopyCode }
