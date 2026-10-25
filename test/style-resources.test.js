'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { TextDocument } = require('vscode-languageserver-textdocument')
const { createStyleResources, registerStyleResources } = require('../src/style-resources')

function document(file, text, language = 'scss') {
  const source = TextDocument.create(pathToFileURL(file).toString(), language, 1, text)
  return {
    fileName: file, languageId: language, version: 1, isClosed: false,
    uri: { scheme: 'file', fsPath: file, toString: () => source.uri },
    getText: range => source.getText(range), offsetAt: at => source.offsetAt(at), positionAt: at => source.positionAt(at)
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-style-resource-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, text = '') => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }
  write('jsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@src/*': ['src/*'] } } }))
  const file = write('src/styles/page.scss')
  const theme = write('src/styles/theme.scss', '.theme {}')
  const picture = write('src/assets/right-jump.png')
  return { root, file, theme, picture, write }
}

test('style references preserve static import and URL ranges and ignore comments and dynamic values', () => {
  const text = `/* @import "./fake.scss"; */
@import "./../apply/common.scss";
@import (reference) "@src/styles/theme";
.card { background: url("../../assets/img/right-jump.png");
  content: 'url("./fake.png")'; background: url(@image); mask: url(var(--icon)); }
@import "@{name}.less";`
  const service = createStyleResources()
  const doc = document('/app/styles/page.less', text, 'less')
  const values = service.references(doc)
  assert.deepEqual(values.map(value => [value.reference, value.kind]), [
    ['./../apply/common.scss', 'import'],
    ['@src/styles/theme', 'import'],
    ['../../assets/img/right-jump.png', 'url']
  ])
  assert.ok(values.every(value => text.slice(value.start, value.end) === value.reference && value.closed))
})

test('standalone style definitions resolve relative imports, aliases and resource URLs', async t => {
  const f = fixture(t)
  const text = `@import "./theme.scss"; @import "@src/styles/theme";
    .card { background-image: url("../assets/right-jump.png"); }`
  const doc = document(f.file, text)
  const service = createStyleResources()
  for (const [marker, expected] of [
    ['./theme.scss', f.theme], ['@src/styles/theme', f.theme], ['../assets/right-jump.png', f.picture]
  ]) {
    assert.equal(await service.definition(doc, text.indexOf(marker) + 2, { workspaceRoot: f.root }), expected)
  }
})

test('style imports keep their kind across comments, long spacing and comma separated paths', async t => {
  const f = fixture(t)
  const other = f.write('src/styles/other.scss')
  const text = `@import /* theme */ "./theme", "./other";
@import ${' '.repeat(600)}"./theme";
.card { content: "@import './missing'"; }`
  const doc = document(f.file, text)
  const service = createStyleResources()
  assert.deepEqual(service.references(doc).map(value => value.kind), ['import', 'import', 'import'])
  assert.equal(await service.definition(doc, text.indexOf('./other') + 2, { workspaceRoot: f.root }), other)
  assert.equal(await service.definition(doc, text.lastIndexOf('./theme') + 2, { workspaceRoot: f.root }), f.theme)
})

test('unfinished style paths complete one directory without consuming following CSS', async t => {
  const f = fixture(t)
  for (const text of ['@import "@src/styles/th', '.card { background: url("@src/assets/ri']) {
    const doc = document(f.file, text)
    const service = createStyleResources()
    const result = await service.complete(doc, text.length, { workspaceRoot: f.root })
    assert.ok(result.items.some(value => value.name === (text.includes('styles') ? 'theme.scss' : 'right-jump.png')))
    assert.equal(result.end, text.length)
    assert.equal(await service.definition(doc, text.length - 1, { workspaceRoot: f.root }), null)
  }
  const text = '@import "@src/styles/th";\n.card { color: red; }'
  const service = createStyleResources()
  const result = await service.complete(document(f.file, text), text.indexOf('th";') + 2, { workspaceRoot: f.root })
  assert.equal(text.slice(result.start, result.end), 'th')
  assert.equal(text.slice(result.end), '";\n.card { color: red; }')
})

test('style resolution refreshes aliases, suppresses ambiguity, cancellation and non-static URLs', async t => {
  const f = fixture(t)
  f.write('src/styles/theme.css', '.other {}')
  const service = createStyleResources()
  const text = '@import "@src/styles/theme";'
  const doc = document(f.file, text)
  assert.equal(await service.definition(doc, text.indexOf('theme') + 1, { workspaceRoot: f.root }), null)
  const alternate = f.write('other/theme.scss', '.alternate {}')
  f.write('jsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@src/*': ['other/*'] } } }))
  const changed = document(f.file, '@import "@src/theme";')
  assert.equal(await service.definition(changed, changed.getText().indexOf('theme') + 1, { workspaceRoot: f.root }), alternate)
  assert.equal(await service.definition(changed, changed.getText().indexOf('theme') + 1,
    { workspaceRoot: f.root, isCancelled: () => true }), null)
  assert.deepEqual(service.references(document(f.file,
    '.x { background:url("https://example.com/x.png"); mask:url("data:image/png,x"); border:url("raw-loader!./x.png") }')), [])
})

function providers(t, root) {
  const values = {}
  const settings = {}
  const disposables = []
  let closes
  const vscode = {
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    Range: class { constructor(start, end) { this.start = start; this.end = end } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range } },
    DocumentLink: class { constructor(range, target) { this.range = range; this.target = target } },
    CompletionItem: class { constructor(label, kind) { this.label = label; this.kind = kind } },
    CompletionItemKind: { File: 1, Folder: 2 },
    languages: Object.fromEntries(['Definition', 'CompletionItem', 'DocumentLink'].map(name =>
      ['register' + name + 'Provider', (selector, provider) => {
        values[name] = provider
        assert.deepEqual(selector.map(value => value.language), ['css', 'scss', 'less'])
        return { dispose() {} }
      }])),
    workspace: {
      getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
      onDidCloseTextDocument(handler) { closes = handler; return { dispose() {} } }
    }
  }
  registerStyleResources(vscode, { subscriptions: disposables })
  t.after(() => disposables.forEach(value => value.dispose()))
  return { ...values, settings, close: doc => closes(doc) }
}

test('standalone providers keep link IO lazy and use only style selectors', async t => {
  const f = fixture(t)
  const text = '@import "@src/styles/theme";'
  const doc = document(f.file, text)
  const p = providers(t, f.root)
  const links = p.DocumentLink.provideDocumentLinks(doc, {})
  assert.equal(links.length, 1)
  assert.equal(links[0].target, undefined, 'link target IO must be deferred')
  const resolved = await p.DocumentLink.resolveDocumentLink(links[0], {})
  assert.equal(resolved.target?.fsPath, f.theme)
  const definition = await p.Definition.provideDefinition(doc, doc.positionAt(text.indexOf('theme') + 1), {})
  assert.equal(definition.uri.fsPath, f.theme)
  p.close(doc)
  doc.version++
  const pending = p.DocumentLink.provideDocumentLinks(doc, {})[0]
  doc.version++
  const stale = await p.DocumentLink.resolveDocumentLink(pending, {})
  assert.equal(stale.target, undefined)
})

test('standalone providers respect settings and cancellation for pending links and completion', async t => {
  const f = fixture(t)
  const text = '@import "@src/styles/theme.scss";'
  const doc = document(f.file, text)
  const p = providers(t, f.root)
  const position = doc.positionAt(text.indexOf('theme') + 2)
  const link = p.DocumentLink.provideDocumentLinks(doc, {})[0]
  p.settings['definition.enabled'] = false
  assert.equal(await p.Definition.provideDefinition(doc, position, {}), undefined)
  assert.deepEqual(p.DocumentLink.provideDocumentLinks(doc, {}), [])
  assert.equal((await p.DocumentLink.resolveDocumentLink(link, {})).target, undefined)
  p.settings['completion.enabled'] = false
  assert.equal(await p.CompletionItem.provideCompletionItems(doc, position, {}), undefined)
  p.settings['completion.enabled'] = true
  assert.equal(await p.CompletionItem.provideCompletionItems(doc, position, { isCancellationRequested: true }), undefined)
  p.settings['definition.enabled'] = true
  assert.equal((await p.DocumentLink.resolveDocumentLink(link, { isCancellationRequested: true })).target, undefined)
})

test('an edit during a directory read suppresses obsolete style completions', async t => {
  const f = fixture(t)
  const text = '@import "@src/styles/th'
  const doc = document(f.file, text)
  const result = await createStyleResources().complete(doc, text.length, {
    workspaceRoot: f.root,
    async readDirectory(file) {
      doc.version++
      return fs.readdirSync(file, { withFileTypes: true })
    }
  })
  assert.deepEqual(result.items, [])
})
