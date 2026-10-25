'use strict'

const RESOURCE_DIRECTORY_DETAIL = 'VueClick resource directory'
async function nativeOwnsDirectory(vscode, document, completion, token, version = document.version) {
  const current = () => document.version === version && !document.isClosed && !token?.isCancellationRequested
  if (!current()) {
    return null
  }
  if (!completion.nativeDirectory) {
    return false
  }
  const settings = vscode.workspace.getConfiguration(document.languageId.startsWith('typescript') ? 'typescript' : 'javascript', document.uri)
  if (!settings.get('suggest.enabled', true) || !settings.get('suggest.paths', true)) {
    return false
  }
  const extension = vscode.extensions?.getExtension('vscode.typescript-language-features')
  if (!extension) {
    return false
  }
  try {
    if (!extension.isActive) {
      await extension.activate()
    }
  } catch {
    return false
  }
  return current() ? true : null
}

module.exports = { nativeOwnsDirectory, RESOURCE_DIRECTORY_DETAIL }
