'use strict'

const { createLanguageClient } = require('./language-client')
const { createEmbeddedService } = require('./embedded')
const { declarationInfo, documentSymbols, nodeAt } = require('./insight')
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')

function registerAdvanced(vscode, context, documentIndex, resolveStatic) {
  const client = createLanguageClient(vscode, context)
  const embedded = createEmbeddedService()
  const selector = [{ language: 'vue', scheme: 'file' }]
  const hoverSelector = ['vue', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact']
    .map(language => ({ language, scheme: 'file' }))
  const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character)
  const span = (document, value) => new vscode.Range(document.positionAt(value.start), document.positionAt(value.start + value.length))
  const enabled = document => vscode.workspace.getConfiguration('vueClick', document.uri).get('languageService.enabled', true)
  const documentContext = {
    resolveReference(reference, base) {
      try {
        return new URL(reference, base).toString()
      } catch {
        return pathToFileURL(path.resolve(path.dirname(fileURLToPath(base)), reference)).toString()
      }
    }
  }
  function markdown(value) {
    const result = new vscode.MarkdownString(value || '')
    result.isTrusted = false
    return result
  }
  function docs(info) {
    return [info?.documentation, ...(info?.tags || []).map(tag => `*@${tag.name}* ${tag.text}`)].filter(Boolean).join('\n\n')
  }
  async function query(method, document, position, token, args) {
    if (!enabled(document)) {
      return undefined
    }
    try {
      return await client.request(method, document, position, token, args)
    } catch (error) {
      console.error(`[Vue2Click] ${method}:`, error)
      return undefined
    }
  }
  async function location(entry) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.fileName))
    return new vscode.Location(document.uri, span(document, entry.textSpan))
  }
  function completeItem(entry, document, defaultRange) {
    const kinds = { method: 'Method', function: 'Function', class: 'Class', interface: 'Interface',
      property: 'Property', const: 'Constant', var: 'Variable', let: 'Variable', alias: 'Reference', keyword: 'Keyword' }
    const item = new vscode.CompletionItem(entry.name || entry.label, vscode.CompletionItemKind[kinds[entry.kind] || 'Property'])
    item.detail = entry.detail || entry.source
    item.sortText = entry.sortText
    if (entry.replacementSpan) {
      item.range = span(document, entry.replacementSpan)
    } else if (entry.textEdit) {
      item.range = range(entry.textEdit.range)
    } else if (defaultRange) {
      item.range = range(defaultRange)
    }
    const insert = entry.insertText || entry.textEdit?.newText || entry.name || entry.label
    item.insertText = entry.isSnippet || entry.insertTextFormat === 2 ? new vscode.SnippetString(insert) : insert
    if (entry.documentation) {
      item.documentation = markdown(typeof entry.documentation === 'string' ? entry.documentation : entry.documentation.value)
    }
    return item
  }
  const register = (name, ...args) => {
    context.subscriptions.push(vscode.languages[name](...args))
  }
  register('registerDocumentSymbolProvider', selector, {
    provideDocumentSymbols(document) {
      function convert(value) {
        const symbol = new vscode.DocumentSymbol(value.name, '', vscode.SymbolKind[value.kind],
          new vscode.Range(document.positionAt(value.start), document.positionAt(value.end)),
          new vscode.Range(document.positionAt(value.selectionStart), document.positionAt(value.selectionEnd)))
        symbol.children = value.children.map(convert)
        return symbol
      }
      return documentSymbols(documentIndex(document)).map(convert)
    }
  })
  register('registerHoverProvider', hoverSelector, {
    async provideHover(document, position, token) {
      const index = documentIndex(document)
      const entry = embedded.at(document, index, position)
      if (entry) {
        const info = entry.service.doHover(entry.document, position, entry.parsed)
        if (info) {
          const contents = Array.isArray(info.contents) ? info.contents : [info.contents]
          return new vscode.Hover(contents.map(value => markdown(typeof value === 'string' ? value : value.value)),
            info.range ? range(info.range) : undefined)
        }
      }
      const info = await query('quickInfo', document, position, token)
      const hit = await resolveStatic(document, position, token)
      let fallback = hit?.index && declarationInfo(hit.index, hit.start)
      const cursor = nodeAt(index, document.offsetAt(position))
      if (!fallback && cursor?.parent?.name === cursor) {
        fallback = declarationInfo(index, document.offsetAt(position))
      }
      if (!fallback?.documentation && !docs(info)) {
        const definitions = await query('indirectDefinitions', document, position, token)
        if (definitions?.[0]) {
          const target = await vscode.workspace.openTextDocument(vscode.Uri.file(definitions[0].fileName))
          fallback = declarationInfo(documentIndex(target), definitions[0].textSpan.start)
        }
      }
      if (hit?.stale || token?.isCancellationRequested) {
        return undefined
      }
      const description = docs(info) || fallback?.documentation
      if (!info && !description && !fallback?.text) {
        return undefined
      }
      const contents = new vscode.MarkdownString()
      contents.isTrusted = false
      const signature = info?.text || fallback?.text
      if (signature) {
        contents.appendCodeblock(signature, 'typescript')
      }
      if (description) {
        contents.appendMarkdown('\n\n' + description)
      }
      return new vscode.Hover(contents, info?.span ? span(document, info.span) : undefined)
    }
  })
  register('registerSignatureHelpProvider', selector, {
    async provideSignatureHelp(document, position, token) {
      const info = await query('signature', document, position, token)
      if (!info) {
        return undefined
      }
      const result = new vscode.SignatureHelp()
      result.activeSignature = info.selected
      result.activeParameter = info.argument
      result.signatures = info.items.map(entry => {
        const signature = new vscode.SignatureInformation(
          entry.prefix + entry.parameters.map(parameter => parameter.label).join(entry.separator) + entry.suffix,
          markdown(entry.documentation))
        signature.parameters = entry.parameters.map(parameter => new vscode.ParameterInformation(parameter.label, markdown(parameter.documentation)))
        return signature
      })
      return result
    }
  }, '(', ',')
  register('registerReferenceProvider', selector, {
    async provideReferences(document, position, options, token) {
      const entry = embedded.at(document, documentIndex(document), position)
      if (entry && entry.language !== 'html') {
        return entry.service.findReferences(entry.document, position, entry.parsed)
          .map(value => new vscode.Location(vscode.Uri.parse(value.uri), range(value.range)))
      }
      const entries = await query('references', document, position, token, { includeDeclaration: options.includeDeclaration })
      const result = await Promise.all((entries || []).map(location))
      return token?.isCancellationRequested ? [] : result
    }
  })
  register('registerRenameProvider', selector, {
    async prepareRename(document, position, token) {
      const entry = embedded.at(document, documentIndex(document), position)
      const cssRange = entry && entry.language !== 'html' &&
        entry.service.prepareRename(entry.document, position, entry.parsed)
      if (cssRange) {
        return range(cssRange)
      }
      if (entry) {
        throw new Error('此位置没有可重命名的 CSS 符号；HTML 标签可使用关联编辑。')
      }
      const info = await query('renameInfo', document, position, token)
      if (!info?.canRename) {
        throw new Error(info?.localizedErrorMessage || '此位置无法进行语义重命名。')
      }
      return { range: span(document, info.triggerSpan), placeholder: info.displayName }
    },
    async provideRenameEdits(document, position, newName, token) {
      if (!enabled(document)) {
        return undefined
      }
      const version = document.version
      const embeddedEntry = embedded.at(document, documentIndex(document), position)
      if (embeddedEntry && embeddedEntry.language !== 'html') {
        const edits = embeddedEntry.service.doRename(embeddedEntry.document, position, newName, embeddedEntry.parsed)
        const result = new vscode.WorkspaceEdit()
        for (const edit of edits.changes?.[document.uri.toString()] || []) {
          result.replace(document.uri, range(edit.range), edit.newText)
        }
        return result
      }
      const entries = await client.request('rename', document, position, token, { name: newName })
      const result = new vscode.WorkspaceEdit()
      const targets = new Map()
      for (const entry of entries || []) {
        const target = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.fileName))
        targets.set(target, target.version)
        const actual = target.getText(span(target, entry.textSpan))
        if (entry.expectedText !== actual) {
          throw new Error('重命名目标已发生变化，请重新执行重命名。')
        }
        result.replace(target.uri, span(target, entry.textSpan), (entry.prefixText || '') + (entry.newName || newName) + (entry.suffixText || ''))
      }
      return token?.isCancellationRequested || document.version !== version ||
        [...targets].some(([target, targetVersion]) => target.version !== targetVersion) ? undefined : result
    }
  })
  register('registerCompletionItemProvider', selector, {
    async provideCompletionItems(document, position, token) {
      if (!vscode.workspace.getConfiguration('vueClick', document.uri).get('completion.enabled', true)) {
        return undefined
      }
      const index = documentIndex(document)
      const entry = embedded.at(document, index, position)
      if (entry) {
        const result = await entry.service.doComplete2(entry.document, position, entry.parsed, documentContext)
        const extra = entry.language === 'html' ? await query('indirectCompletion', document, position, token) : []
        return new vscode.CompletionList([
          ...result.items.map(value => completeItem(value, document)),
          ...(extra || []).map(value => completeItem(value, document))
        ], result.isIncomplete)
      }
      const info = await query('completion', document, position, token) || { entries: [] }
      const extra = await query('indirectCompletion', document, position, token)
      const names = new Set(info.entries.map(value => value.name))
      info.entries.push(...(extra || []).filter(value => !names.has(value.name)))
      return info ? new vscode.CompletionList(info.entries.map(value => {
        const item = completeItem(value, document)
        item.vueClick = { document, position, entry: value, version: document.version }
        return item
      }), info.isIncomplete) : undefined
    },
    async resolveCompletionItem(item, token) {
      const value = item.vueClick
      if (!value || value.document.version !== value.version) {
        return item
      }
      const detail = await query('completionDetails', value.document, value.position, token, value.entry)
      if (!detail) {
        return item
      }
      item.detail = detail.text
      item.documentation = markdown(docs(detail))
      const changes = detail.actions.flatMap(action => action.changes)
      // Completion edits may only target the completion's own document.
      if (changes.some(change => change.fileName !== value.document.fileName)) {
        return item
      }
      item.additionalTextEdits = changes.flatMap(change => change.textChanges.map(edit =>
        vscode.TextEdit.replace(span(value.document, edit.span), edit.newText)))
      return item
    }
  }, '.', '<', ':', '@', '"', "'", '/', '-')
  register('registerDocumentFormattingEditProvider', selector, {
    provideDocumentFormattingEdits(document, options) {
      const { TextDocument } = require('vscode-languageserver-textdocument')
      const index = documentIndex(document)
      return embedded.entries(document, index).flatMap(entry => {
        const blockRange = { start: document.positionAt(entry.block.start), end: document.positionAt(entry.block.end) }
        const source = TextDocument.create(document.uri.toString(), entry.language, document.version, index.text)
        // Limit every formatter edit to the inner block; JS is formatted by its language service.
        return entry.service.format(source, blockRange, { ...options, wrapLineLength: 120,
          templating: true, indentInnerHtml: true }).filter(edit =>
          source.offsetAt(edit.range.start) >= entry.block.start && source.offsetAt(edit.range.end) <= entry.block.end)
          .map(edit => vscode.TextEdit.replace(range(edit.range), edit.newText))
      })
    }
  })
  register('registerColorProvider', selector, {
    provideDocumentColors(document) {
      return embedded.entries(document, documentIndex(document)).filter(entry => entry.language !== 'html')
        .flatMap(entry => entry.service.findDocumentColors(entry.document, entry.parsed))
        .map(value => new vscode.ColorInformation(range(value.range),
          new vscode.Color(value.color.red, value.color.green, value.color.blue, value.color.alpha)))
    },
    provideColorPresentations(color, options) {
      const index = documentIndex(options.document)
      const entry = embedded.at(options.document, index, options.range.start)
      if (!entry || entry.language === 'html') {
        return []
      }
      return entry.service.getColorPresentations(entry.document, entry.parsed, color, options.range)
        .map(value => {
          const result = new vscode.ColorPresentation(value.label)
          if (value.textEdit) {
            result.textEdit = vscode.TextEdit.replace(range(value.textEdit.range), value.textEdit.newText)
          }
          return result
        })
    }
  })
  register('registerLinkedEditingRangeProvider', selector, {
    provideLinkedEditingRanges(document, position) {
      const entry = embedded.at(document, documentIndex(document), position)
      const ranges = entry?.language === 'html' && entry.service.findLinkedEditingRanges(entry.document, position, entry.parsed)
      return ranges ? new vscode.LinkedEditingRanges(ranges.map(range)) : undefined
    }
  })
  register('registerDocumentLinkProvider', selector, {
    provideDocumentLinks(document) {
      return embedded.entries(document, documentIndex(document)).flatMap(entry =>
        (entry.language === 'html'
          ? entry.service.findDocumentLinks(entry.document, documentContext)
          : entry.service.findDocumentLinks(entry.document, entry.parsed, documentContext))
          .filter(value => value.target).map(value =>
            new vscode.DocumentLink(range(value.range), vscode.Uri.parse(value.target))))
    }
  })
  register('registerDocumentHighlightProvider', selector, {
    provideDocumentHighlights(document, position) {
      const entry = embedded.at(document, documentIndex(document), position)
      return entry ? entry.service.findDocumentHighlights(entry.document, position, entry.parsed)
        .map(value => new vscode.DocumentHighlight(range(value.range), value.kind)) : undefined
    }
  })
  register('registerFoldingRangeProvider', selector, {
    provideFoldingRanges(document) {
      return embedded.entries(document, documentIndex(document)).flatMap(entry => [
        new vscode.FoldingRange(document.positionAt(entry.block.start).line, document.positionAt(entry.block.end).line),
        ...entry.service.getFoldingRanges(entry.document).map(value => new vscode.FoldingRange(value.startLine, value.endLine))
      ])
    }
  })
  register('registerSelectionRangeProvider', selector, {
    provideSelectionRanges(document, positions) {
      function convert(value) {
        return value ? new vscode.SelectionRange(range(value.range), convert(value.parent)) : undefined
      }
      return positions.map(position => {
        const entry = embedded.at(document, documentIndex(document), position)
        const values = entry && (entry.language === 'html'
          ? entry.service.getSelectionRanges(entry.document, [position])
          : entry.service.getSelectionRanges(entry.document, [position], entry.parsed))
        return values?.[0] ? convert(values[0]) : new vscode.SelectionRange(new vscode.Range(position, position))
      })
    }
  })
  const diagnostics = vscode.languages.createDiagnosticCollection('vueClick')
  const timers = new Map()
  function schedule(document) {
    const key = document.uri.toString()
    clearTimeout(timers.get(key))
    if (document.languageId !== 'vue' || document.uri.scheme !== 'file') {
      return
    }
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document !== document) {
      return
    }
    if (!enabled(document) || !vscode.workspace.getConfiguration('vueClick', document.uri).get('diagnostics.enabled', true)) {
      diagnostics.delete(document.uri)
      return
    }
    timers.set(key, setTimeout(async () => {
      timers.delete(key)
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document !== document) {
        return
      }
      const version = document.version
      const result = await query('diagnostics', document, 0)
      if (!result || document.version !== version || document.isClosed) {
        return
      }
      const values = result.entries.map(value => {
        const diagnostic = new vscode.Diagnostic(span(document, value), value.message,
          value.category === 1 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)
        diagnostic.source = 'VueClick TS'
        diagnostic.code = value.code
        return diagnostic
      })
      for (const entry of embedded.entries(document, documentIndex(document))) {
        if (entry.language === 'html') {
          const source = languageTemplateDiagnostics(documentIndex(document))
          values.push(...source.map(value => new vscode.Diagnostic(
            new vscode.Range(document.positionAt(value.start), document.positionAt(value.end)),
            value.message, vscode.DiagnosticSeverity.Error)))
          continue
        }
        for (const value of entry.service.doValidation(entry.document, entry.parsed)) {
          const diagnostic = new vscode.Diagnostic(range(value.range), value.message,
            value.severity === 1 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)
          diagnostic.source = 'VueClick CSS'
          values.push(diagnostic)
        }
      }
      diagnostics.set(document.uri, values)
    }, 600))
  }
  context.subscriptions.push(client, embedded, diagnostics,
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (/(?:^|\/)(?:tsconfig|jsconfig|package)\.json$/.test(event.document.fileName)) {
        client.invalidate()
      }
      schedule(event.document)
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      clearTimeout(timers.get(document.uri.toString()))
      timers.delete(document.uri.toString())
      embedded.close(document)
      diagnostics.delete(document.uri)
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event?.affectsConfiguration && !event.affectsConfiguration('vueClick')) {
        return
      }
      client.invalidate()
      for (const document of vscode.workspace.textDocuments) {
        schedule(document)
      }
    }),
    { dispose() { for (const timer of timers.values()) { clearTimeout(timer) } } })
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      schedule(editor.document)
    }
  }))
  for (const document of vscode.workspace.textDocuments) {
    schedule(document)
  }
  if (vscode.workspace.createFileSystemWatcher) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.vue,*.js,*.jsx,*.ts,*.tsx,*.json,.gitignore}')
    function changed(uri, kind) {
      if (/(?:^|\/)(?:node_modules|\.git)\//.test(uri.fsPath)) {
        return
      }
      client.fileChanged(uri.fsPath, kind)
      for (const document of vscode.workspace.textDocuments) {
        schedule(document)
      }
    }
    context.subscriptions.push(watcher,
      watcher.onDidCreate(uri => changed(uri, 'create')), watcher.onDidDelete(uri => changed(uri, 'delete')),
      watcher.onDidChange(uri => changed(uri, 'change')))
  }
  return {
    async definitions(document, position, token) {
      const entry = embedded.at(document, documentIndex(document), position)
      if (entry && entry.language !== 'html') {
        const result = entry.service.findDefinition(entry.document, position, entry.parsed)
        return result ? [new vscode.Location(vscode.Uri.parse(result.uri), range(result.range))] : []
      }
      let entries = await query('indirectDefinitions', document, position, token)
      if (!entries?.length) {
        entries = await query('definitions', document, position, token)
      }
      return Promise.all((entries || []).map(location))
    }
  }
}

function languageTemplateDiagnostics(index) {
  const block = index.blocks.find(block => block.tag === 'template' && !block.external && (!block.lang || block.lang === 'html'))
  if (!block) {
    return []
  }
  const result = []
  const { parse } = require('@vue/compiler-dom')
  parse(index.text.slice(block.start, block.end), {
    onError(error) {
      if ([24, 23, 15, 17, 18, 19, 20, 22].includes(error.code)) {
        result.push({ start: block.start + (error.loc?.start.offset || 0),
          end: block.start + (error.loc?.end.offset || 0), message: error.message })
      }
    }
  })
  return result
}

module.exports = { registerAdvanced }
