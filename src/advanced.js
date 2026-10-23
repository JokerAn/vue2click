'use strict'

const { createLanguageClient } = require('./language-client')
const { createEmbeddedService } = require('./embedded')
const { declarationInfo, documentSymbols, nodeAt } = require('./insight')
const { scriptFolding, scriptSelection, scriptFormatting, scriptHighlights } = require('./script-editing')
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')

function registerAdvanced(vscode, context, documentIndex, resolveStatic) {
  const client = createLanguageClient(vscode, context)
  const embedded = createEmbeddedService()
  require('./tag-closing').registerTagClosing(vscode, context, documentIndex, embedded)
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
    if (entry.changes) {
      item.additionalTextEdits = entry.changes.filter(change => change.fileName === document.fileName)
        .flatMap(change => change.textChanges.map(edit => vscode.TextEdit.replace(span(document, edit.span), edit.newText)))
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
      const reference = index.templateReferences.find(value => document.offsetAt(position) >= value.start && document.offsetAt(position) < value.end)
      const component = reference ? await query('componentHover', document, position, token) : null
      if (component) {
        const contents = new vscode.MarkdownString()
        contents.appendCodeblock(component.text, 'typescript')
        if (component.documentation) {
          contents.appendMarkdown('\n\n' + component.documentation)
        }
        return new vscode.Hover(contents, span(document, component.span))
      }
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
      const slot = require('./slots').slotContext(index, document.offsetAt(position))
      if (slot) {
        const items = await query('slotCompletions', document, position, token) || []
        return new vscode.CompletionList(items.map(value => completeItem(value, document)), false)
      }
      const entry = embedded.at(document, index, position)
      const template = require('./template-editing').templateContext(index, document.offsetAt(position))
      let templateItems = []
      if (template) {
        const items = await query('templateCompletions', document, position, token) || []
        const extra = template.kind === 'tag' ? await query('indirectCompletion', document, position, token) || [] : []
        const html = entry?.language === 'html' && await entry.service.doComplete2(entry.document, position, entry.parsed, documentContext)
        templateItems = [
          ...items.map(value => completeItem(value, document)),
          ...extra.map(value => completeItem(value, document)),
          ...(html?.items || []).map(value => completeItem(value, document))
        ]
        if (template.kind !== 'value' || !template.bound) {
          return new vscode.CompletionList(templateItems, false)
        }
      }
      if (entry) {
        const result = await entry.service.doComplete2(entry.document, position, entry.parsed, documentContext)
        const extra = entry.language === 'html' ? await query('indirectCompletion', document, position, token) : []
        const config = vscode.workspace.getConfiguration('emmet', document.uri)
        const keys = ['showExpandedAbbreviation', 'showAbbreviationSuggestions', 'syntaxProfiles', 'variables',
          'preferences', 'excludeLanguages', 'showSuggestionsAsSnippets']
        const options = Object.fromEntries(keys.map(key => [key, config.get(key)]).filter(([, value]) => value !== undefined))
        const nativeEmmet = vscode.extensions?.getExtension('vscode.emmet')
        const mappings = config.get('includeLanguages', {})
        const nativeVueEmmet = nativeEmmet?.isActive && ['vue', 'vueclick-html'].some(language =>
          ['html', 'xml'].includes(mappings[language]))
        const emmet = !nativeVueEmmet && !options.excludeLanguages?.includes('vue')
          ? require('./emmet').emmetCompletions(entry, position, options) : []
        return new vscode.CompletionList([
          ...result.items.map(value => completeItem(value, document)),
          ...(extra || []).map(value => completeItem(value, document)),
          ...emmet.map(value => completeItem(value, document))
        ], result.isIncomplete)
      }
      const info = await query('completion', document, position, token) || { entries: [] }
      const extra = await query('indirectCompletion', document, position, token)
      const names = new Set(info.entries.map(value => value.name))
      info.entries.push(...(extra || []).filter(value => !names.has(value.name)))
      return new vscode.CompletionList([...templateItems, ...info.entries.map(value => {
        const item = completeItem(value, document)
        item.vueClick = { document, position, entry: value, version: document.version }
        return item
      })], info.isIncomplete)
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
  }, '.', '<', ':', '@', '"', "'", '/', '-', '#', '{', ',')
  register('registerDocumentFormattingEditProvider', selector, {
    provideDocumentFormattingEdits(document, options) {
      if (!vscode.workspace.getConfiguration('vueClick', document.uri).get('formatting.enabled', true)) {
        return []
      }
      const { TextDocument } = require('vscode-languageserver-textdocument')
      const index = documentIndex(document)
      const language = index.blocks.some(block => block.tag === 'script' && /^(ts|tsx|typescript)$/.test(block.lang || '')) ? 'typescript' : 'javascript'
      const settings = vscode.workspace.getConfiguration(language + '.format', document.uri)
      const keys = ['insertSpaceAfterCommaDelimiter', 'insertSpaceBeforeAndAfterBinaryOperators',
        'insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces', 'semicolons', 'placeOpenBraceOnNewLineForFunctions']
      const scriptOptions = Object.fromEntries(keys.map(key => [key, settings.get(key)]).filter(([, value]) => value !== undefined))
      const scripts = scriptFormatting(index, { ...options, ...scriptOptions })
        .map(edit => vscode.TextEdit.replace(span(document, edit.span), edit.newText))
      return [...scripts, ...embedded.entries(document, index).flatMap(entry => {
        const blockRange = { start: document.positionAt(entry.block.start), end: document.positionAt(entry.block.end) }
        const source = TextDocument.create(document.uri.toString(), entry.language, document.version, index.text)
        // Each embedded formatter must stay inside its own source block.
        return entry.service.format(source, blockRange, { ...options, wrapLineLength: 120,
          templating: true, indentInnerHtml: true }).filter(edit =>
          source.offsetAt(edit.range.start) >= entry.block.start && source.offsetAt(edit.range.end) <= entry.block.end)
          .map(edit => vscode.TextEdit.replace(range(edit.range), edit.newText))
      })]
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
      const index = documentIndex(document)
      const offset = document.offsetAt(position)
      if (index.blocks.some(block => block.tag === 'script' && !block.external && offset >= block.start && offset <= block.end)) {
        return scriptHighlights(index, offset).map(value => new vscode.DocumentHighlight(span(document, value.textSpan),
          value.kind === 'writtenReference' ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read))
      }
      const entry = embedded.at(document, index, position)
      return entry ? entry.service.findDocumentHighlights(entry.document, position, entry.parsed)
        .map(value => new vscode.DocumentHighlight(range(value.range), value.kind)) : undefined
    }
  })
  register('registerFoldingRangeProvider', selector, {
    provideFoldingRanges(document) {
      const index = documentIndex(document)
      const scripts = scriptFolding(index).map(value => new vscode.FoldingRange(
        document.positionAt(value.start).line, document.positionAt(value.end).line))
      return [...scripts, ...embedded.entries(document, index).flatMap(entry => [
        new vscode.FoldingRange(document.positionAt(entry.block.start).line, document.positionAt(entry.block.end).line),
        ...entry.service.getFoldingRanges(entry.document).map(value => new vscode.FoldingRange(value.startLine, value.endLine))
      ])]
    }
  })
  register('registerSelectionRangeProvider', selector, {
    provideSelectionRanges(document, positions) {
      function convert(value) {
        return value ? new vscode.SelectionRange(range(value.range), convert(value.parent)) : undefined
      }
      return positions.map(position => {
        const index = documentIndex(document)
        const offset = document.offsetAt(position)
        if (index.blocks.some(block => block.tag === 'script' && !block.external && offset >= block.start && offset <= block.end)) {
          function scriptRange(value) {
            return value ? new vscode.SelectionRange(span(document, value.textSpan), scriptRange(value.parent)) : undefined
          }
          return scriptRange(scriptSelection(index, offset))
        }
        const entry = embedded.at(document, index, position)
        const values = entry && (entry.language === 'html'
          ? entry.service.getSelectionRanges(entry.document, [position])
          : entry.service.getSelectionRanges(entry.document, [position], entry.parsed))
        return values?.[0] ? convert(values[0]) : new vscode.SelectionRange(new vscode.Range(position, position))
      })
    }
  })
  const diagnostics = vscode.languages.createDiagnosticCollection('vueClick')
  const timers = new Map()
  let output
  context.subscriptions.push(vscode.commands.registerCommand('vueClick.restartLanguageService', () => {
    for (const timer of timers.values()) {
      clearTimeout(timer)
    }
    timers.clear()
    client.invalidate()
    diagnostics.clear()
    vscode.window.showInformationMessage('VueClick 语言服务已释放，将在下次请求时重新启动。')
    return true
  }), vscode.commands.registerCommand('vueClick.showProjectInfo', () => {
    const document = vscode.window.activeTextEditor?.document
    const info = {
      file: document?.uri.scheme === 'file' ? document.fileName : undefined,
      languageServiceEnabled: document ? enabled(document) : undefined,
      automaticDiagnostics: document ? vscode.workspace.getConfiguration('vueClick', document.uri).get('diagnostics.enabled', false) : undefined,
      ...client.status(document)
    }
    if (!output) {
      output = vscode.window.createOutputChannel('VueClick')
      context.subscriptions.push(output)
    }
    output.clear()
    output.appendLine(JSON.stringify(info, null, 2))
    output.show(true)
    return info
  }))
  context.subscriptions.push(vscode.commands.registerCommand('vueClick.checkCurrentFile', async () => {
    const document = vscode.window.activeTextEditor?.document
    if (!document || document.languageId !== 'vue' || document.uri.scheme !== 'file') {
      return vscode.window.showInformationMessage('请先打开一个 Vue 文件。')
    }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'VueClick: 检查当前文件', cancellable: true }, (_, token) => checkDocument(document, token))
  }))
  function workspaceEdit(document, changes) {
    const result = new vscode.WorkspaceEdit()
    for (const change of changes || []) {
      if (change.fileName !== document.fileName || change.isNewFile) {
        return undefined
      }
      for (const edit of change.textChanges) {
        result.replace(document.uri, span(document, edit.span), edit.newText)
      }
    }
    return result
  }
  register('registerCodeActionsProvider', selector, {
    async provideCodeActions(document, selection, context, token) {
      const actions = []
      const sourceOnly = context.only?.value?.startsWith('source.')
      if (!context.only || sourceOnly) {
        for (const [title, kind, mode] of [
          ['VueClick: 整理 import', vscode.CodeActionKind.SourceOrganizeImports, 'SortAndCombine'],
          ['VueClick: 移除未使用 import', vscode.CodeActionKind.Source.append('removeUnusedImports'), 'RemoveUnused']
        ]) {
          if (!context.only || context.only.contains(kind)) {
            const action = new vscode.CodeAction(title, kind)
            action.vueClick = { document, version: document.version, mode }
            actions.push(action)
          }
        }
      }
      if (!sourceOnly && (!context.only || context.only.contains(vscode.CodeActionKind.QuickFix)) &&
        context.triggerKind !== vscode.CodeActionTriggerKind.Automatic) {
        const index = documentIndex(document)
        const candidate = require('./template-methods').templateMethod(index, document.offsetAt(selection.start))
        if (candidate) {
          const changes = enabled(document)
            ? await query('createTemplateMethod', document, selection.start, token, {
              tabSize: vscode.workspace.getConfiguration('editor', document.uri).get('tabSize', 2),
              insertSpaces: vscode.workspace.getConfiguration('editor', document.uri).get('insertSpaces', true)
            }) : candidate.changes
          if (changes && !token?.isCancellationRequested) {
            const action = new vscode.CodeAction(`VueClick: 生成方法 ${candidate.name}`, vscode.CodeActionKind.QuickFix)
            action.edit = workspaceEdit(document, changes)
            if (action.edit) {
              actions.push(action)
            }
          }
        }
      }
      const errors = context.diagnostics.filter(value => [2304, 2552, 6133, 6192].includes(Number(value.code)))
      if (!sourceOnly && !errors.length && context.triggerKind !== vscode.CodeActionTriggerKind.Automatic) {
        errors.push(...(diagnostics.get(document.uri) || []).filter(value =>
          [2304, 2552, 6133, 6192].includes(Number(value.code)) && value.range.intersection(selection)))
      }
      if (!sourceOnly && errors.length) {
        const fixes = await query('codeFixes', document, selection.start, token,
          { end: document.offsetAt(selection.end), codes: errors.map(value => Number(value.code)) }) || []
        for (const fix of fixes) {
          const edit = workspaceEdit(document, fix.changes)
          if (edit) {
            const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix)
            action.edit = edit
            action.diagnostics = errors
            actions.push(action)
          }
        }
      }
      return actions
    },
    async resolveCodeAction(action, token) {
      const value = action.vueClick
      if (value && value.document.version === value.version) {
        const changes = await query('organizeImports', value.document, 0, token, { mode: value.mode })
        if (value.document.version === value.version) {
          action.edit = workspaceEdit(value.document, changes)
        }
      }
      return action
    }
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.SourceOrganizeImports,
    vscode.CodeActionKind.Source.append('removeUnusedImports')] })
  async function checkDocument(document, token) {
    const version = document.version
    const result = await query('diagnostics', document, 0, token)
    if (!result || token?.isCancellationRequested || document.version !== version || document.isClosed) {
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
    return values.length
  }
  function schedule(document) {
    const key = document.uri.toString()
    clearTimeout(timers.get(key))
    if (document.languageId !== 'vue' || document.uri.scheme !== 'file') {
      return
    }
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document !== document) {
      return
    }
    if (!enabled(document) || !vscode.workspace.getConfiguration('vueClick', document.uri).get('diagnostics.enabled', false)) {
      diagnostics.delete(document.uri)
      return
    }
    timers.set(key, setTimeout(async () => {
      timers.delete(key)
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document !== document) {
        return
      }
      await checkDocument(document)
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
      client.close(document)
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
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    // The main watcher covers source and JSON files. Vetur metadata can use another extension.
    if (document.uri.scheme === 'file' && !/\.(?:json|vue|[cm]?[jt]sx?)$/i.test(document.fileName)) {
      client.fileChanged(document.fileName, 'change')
    }
  }))
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
      const index = documentIndex(document)
      const versions = new Map([[document, document.version]])
      const cancelled = () => token?.isCancellationRequested ||
        [...versions].some(([source, version]) => source.isClosed || source.version !== version)
      const styles = await require('./style-navigation').findStyleDefinitions(index, document.offsetAt(position), {
        isCancelled: cancelled,
        async readFile(fileName) {
          if (cancelled()) {
            return null
          }
          let target = vscode.workspace.textDocuments.find(source => source.fileName === fileName && !source.isClosed)
          if (!target) {
            const stat = await require('node:fs/promises').stat(fileName)
            if (stat.size > 256 * 1024 || cancelled()) {
              return null
            }
            target = await vscode.workspace.openTextDocument(vscode.Uri.file(fileName))
          }
          versions.set(target, target.version)
          const text = target.getText(new vscode.Range(target.positionAt(0), target.positionAt(256 * 1024 + 1)))
          return text.length <= 256 * 1024 ? text : null
        }
      })
      if (cancelled()) {
        return []
      }
      if (styles.length) {
        const values = await Promise.all(styles.map(location))
        return cancelled() ? [] : values
      }
      const entry = embedded.at(document, index, position)
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
