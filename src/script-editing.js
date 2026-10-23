'use strict'

const ts = require('typescript')
const services = new WeakMap()

function scriptService(index) {
  let service = services.get(index)
  if (!service) {
    const file = index.fileName
    const snapshot = ts.ScriptSnapshot.fromString(index.source)
    service = ts.createLanguageService({
      getCompilationSettings: () => ({ allowJs: true, noLib: true, allowNonTsExtensions: true }),
      getScriptFileNames: () => [file],
      getScriptVersion: () => '1',
      getScriptKind: () => index.root.scriptKind,
      getScriptSnapshot: name => name === file ? snapshot : undefined,
      getCurrentDirectory: () => '',
      getDefaultLibFileName: () => '',
      fileExists: name => name === file,
      readFile: () => undefined
    })
    services.set(index, service)
  }
  return service
}

function scriptFolding(index) {
  return scriptService(index).getOutliningSpans(index.fileName)
    .map(value => ({ start: value.textSpan.start, end: value.textSpan.start + value.textSpan.length }))
}

function scriptSelection(index, offset) {
  return scriptService(index).getSmartSelectionRange(index.fileName, offset)
}

function scriptHighlights(index, offset) {
  return (scriptService(index).getDocumentHighlights(index.fileName, offset, [index.fileName]) || [])
    .flatMap(group => group.highlightSpans)
}

function scriptFormatting(index, options) {
  return scriptService(index).getFormattingEditsForDocument(index.fileName, {
    indentSize: options.tabSize, convertTabsToSpaces: options.insertSpaces,
    newLineCharacter: index.text.includes('\r\n') ? '\r\n' : '\n',
    insertSpaceAfterCommaDelimiter: true, insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true, insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    placeOpenBraceOnNewLineForFunctions: false, placeOpenBraceOnNewLineForControlBlocks: false,
    ...options
  }).filter(edit => index.blocks.some(block => block.tag === 'script' && !block.external &&
    edit.span.start >= block.start && edit.span.start + edit.span.length <= block.end))
}

module.exports = { scriptFolding, scriptSelection, scriptFormatting, scriptHighlights }
