'use strict'

const RESOURCE_DIRECTORY_DETAIL = 'VueClick resource directory'

async function nativePathFolders(vscode, document, position, token, version = document.version, context) {
  const current = () => document.version === version && !document.isClosed && !token?.isCancellationRequested
  if (!current()) return null
  if (!vscode.extensions?.getExtension('vscode.typescript-language-features')?.isActive) return new Set()
  const settings = vscode.workspace.getConfiguration(document.languageId.startsWith('typescript') ? 'typescript' : 'javascript', document.uri)
  if (!settings.get('suggest.enabled', true) || !settings.get('suggest.paths', true)) return new Set()
  let result
  try {
    result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position, context?.triggerCharacter, 0)
  } catch (_) {}
  if (!current()) return null
  const folders = (Array.isArray(result?.items) ? result.items : [])
    .filter(item => item.kind === vscode.CompletionItemKind.Folder && item.detail !== RESOURCE_DIRECTORY_DETAIL)
    .map(item => typeof item.label === 'string' ? item.label : item.label?.label)
    .filter(name => typeof name === 'string')
    .map(name => name.replace(/\/$/, ''))
  return new Set(folders)
}

module.exports = { nativePathFolders, RESOURCE_DIRECTORY_DETAIL }
