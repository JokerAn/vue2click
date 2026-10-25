'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { buildIndex } = require('../src/resolver')
const { createEmbeddedService } = require('../src/embedded')
const { TextDocument } = require('vscode-languageserver-textdocument')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vueclick-resources-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (name, contents = '') => {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof contents === 'object' ? JSON.stringify(contents) : contents)
    return file
  }
  const from = await write('src/views/Parent.vue')
  await write('jsconfig.json', { compilerOptions: { paths: { '@src/*': ['missing/*', 'src/*'] } } })
  await write('src/assets/logo.svg', '<svg/>')
  await write('src/assets/nested/photo.png')
  await write('src/styles/theme.scss', '.card {}')
  return { root, from, write }
}

test('resources share static alias rules without treating images or styles as source modules', async t => {
  const f = await fixture(t)
  const { createResourceResolver } = require('../src/resource-paths')
  const resolver = createResourceResolver({ workspaceRoot: f.root })
  for (const specifier of ['../assets/logo.svg', '@src/assets/logo.svg', '@/assets/logo.svg', '~/assets/logo.svg']) {
    assert.equal(await resolver.resolve(specifier, f.from), path.join(f.root, 'src/assets/logo.svg'), specifier)
  }
  assert.equal(await resolver.resolve('@src/styles/theme.scss', f.from), path.join(f.root, 'src/styles/theme.scss'))
  assert.equal(await require('../src/module-paths').resolveModulePath('@src/assets/logo.svg', f.from, { workspaceRoot: f.root }), null)
  for (const specifier of ['https://example.com/a.svg', '//example.com/a.svg', 'data:image/png,xx', '@unknown/logo.svg', '@src/assets/logo.svg?raw', 'raw-loader!./logo.svg']) {
    assert.equal(await resolver.resolve(specifier, f.from), null, specifier)
  }
})

test('resource completion descends one directory and refreshes in a new request', async t => {
  const f = await fixture(t)
  const { createResourceResolver } = require('../src/resource-paths')
  const directories = []
  const resolver = createResourceResolver({ workspaceRoot: f.root, readDirectory: async directory => {
    directories.push(directory)
    return fs.readdir(directory, { withFileTypes: true })
  } })
  assert.deepEqual((await resolver.complete('@src/assets/', f.from)).map(value => value.name), ['logo.svg', 'nested/'])
  assert.deepEqual(directories, [path.join(f.root, 'src/assets')])
  assert.deepEqual((await resolver.complete('@src/assets/nested/', f.from)).map(value => value.name), ['photo.png'])
  assert.deepEqual((await resolver.complete('../assets/lo', f.from)).map(value => value.name), ['logo.svg'])
  await f.write('other/replacement.svg')
  await f.write('jsconfig.json', { compilerOptions: { paths: { '@src/*': ['other/*'] } } })
  assert.equal(await createResourceResolver({ workspaceRoot: f.root }).resolve('@src/replacement.svg', f.from), path.join(f.root, 'other/replacement.svg'))
})

test('ordinary bare resource paths and empty path completion stay relative to the document', async t => {
  const f = await fixture(t)
  const local = await f.write('src/views/images/local.svg')
  const { createResourceResolver } = require('../src/resource-paths')
  const resolver = createResourceResolver({ workspaceRoot: f.root })
  assert.equal(await resolver.resolve('images/local.svg', f.from), local)
  assert.deepEqual((await resolver.complete('images/', f.from)).map(value => value.name), ['local.svg'])
  assert.ok((await resolver.complete('', f.from)).some(value => value.name === 'images/'))
})

test('directory completion context preserves configured paths and resource-only src fallbacks', async t => {
  const f = await fixture(t)
  const { createResourceResolver } = require('../src/resource-paths')
  const resolver = createResourceResolver({ workspaceRoot: f.root })
  for (const specifier of ['@src/assets/', '../assets/', '@/assets/', '~/assets/']) {
    const result = await resolver.completePaths(specifier, f.from)
    assert.equal(result.directory, path.join(f.root, 'src/assets'))
    assert.equal(result.nativeDirectory, ['@src/assets/', '../assets/'].includes(specifier), specifier)
    assert.deepEqual(result.items.map(item => item.name), ['logo.svg', 'nested/'])
  }
  await f.write('jsconfig.json', { compilerOptions: { paths: { '@/*': ['src/*'] } } })
  const explicit = await createResourceResolver({ workspaceRoot: f.root }).completePaths('@/assets/', f.from)
  assert.equal(explicit.directory, path.join(f.root, 'src/assets'))
})

test('empty resource directories remain distinguishable from unresolved source package paths', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.root, 'src/empty'))
  const { createResourceResolver } = require('../src/resource-paths')
  const resolver = createResourceResolver({ workspaceRoot: f.root })
  const empty = await resolver.completePaths('@src/empty/', f.from)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.directory, path.join(f.root, 'src/empty'))
  const missing = await resolver.completePaths('@unknown/package/', f.from)
  assert.deepEqual(missing.items, [])
  assert.equal(missing.directory, undefined)
})

test('resource completion is cancelled and bounded without recursive directory enumeration', async t => {
  const f = await fixture(t)
  const { createResourceResolver } = require('../src/resource-paths')
  let reads = 0
  const resolver = createResourceResolver({ workspaceRoot: f.root, readDirectory: async () => {
    reads++
    return Array.from({ length: 800 }, (_, n) => ({ name: `item${n}`, isDirectory: () => false }))
  } })
  assert.ok((await resolver.complete('@src/assets/', f.from)).length <= 500)
  assert.equal(reads, 1)
  const cancelled = createResourceResolver({ workspaceRoot: f.root, isCancelled: () => true, readDirectory: async () => { throw new Error('must not enumerate') } })
  assert.deepEqual(await cancelled.complete('@src/assets/', f.from), [])
  assert.equal(await cancelled.resolve('@src/assets/logo.svg', f.from), null)
})

test('resource reference ranges cover actual HTML, CSS and top-level style sources only', () => {
  const { resourceReferences } = require('../src/resource-paths')
  const text = `<template><img src="@src/assets/logo.svg"/><img :src="image"/><!-- <img src="./fake.png"/> --></template>
<script>import './theme.scss'; const example = '<style src="./fake.css"/>'</script>
<style lang="scss" src="@src/styles/theme.scss"/>
<style>/* @import "./comment.css"; */ @import "@src/styles/theme.scss"; .x { background: url("@src/assets/logo.svg") }</style>`
  const source = TextDocument.create(pathToFileURL('/app/Parent.vue').toString(), 'vue', 1, text)
  const document = { uri: { toString: () => source.uri }, version: 1 }
  const index = buildIndex(text, 'vue', '/app/Parent.vue')
  const embedded = createEmbeddedService()
  const references = resourceReferences(index, embedded.entries(document, index))
  assert.equal(references.length, 5)
  assert.deepEqual(references.map(value => value.reference).sort(), [
    './theme.scss', '@src/assets/logo.svg', '@src/assets/logo.svg', '@src/styles/theme.scss', '@src/styles/theme.scss'
  ].sort())
  assert.ok(references.every(value => text.slice(value.start, value.end) === value.reference))
  assert.ok(!references.some(value => /fake|comment|image/.test(value.reference)))
  embedded.dispose()
})

test('resource references preserve safe URLs and anchors without introducing executable scheme links', () => {
  const { resourceReferences } = require('../src/resource-paths')
  const text = '<template><a href="https://example.com/a"/><a href="#here"/><a href="command:workbench.action.terminal.new"/><a href="javascript:alert(1)"/><img src="data:image/svg+xml,xx"/></template>' +
    '<style>.x { background: url("command:workbench.action.terminal.new") }</style>'
  const source = TextDocument.create('file:///app/Page.vue', 'vue', 1, text)
  const index = buildIndex(text, 'vue', '/app/Page.vue')
  const embedded = createEmbeddedService()
  const references = resourceReferences(index, embedded.entries({ uri: { toString: () => source.uri }, version: 1 }, index))
  assert.deepEqual(references.map(value => value.reference), ['https://example.com/a', '#here'])
  embedded.dispose()
})

test('static import directory strings are available to path completion before a resource extension is typed', () => {
  const { resourceReferences } = require('../src/resource-paths')
  const text = '<script>import "@src/styles/"</script>'
  const index = buildIndex(text, 'vue', '/app/Page.vue')
  const references = resourceReferences(index, [])
  assert.equal(references.length, 1)
  assert.equal(references[0].reference, '@src/styles/')
  assert.equal(text.slice(references[0].start, references[0].end), '@src/styles/')
})

test('unfinished import strings retain the script boundary and are not complete file links', () => {
  const { resourceReferences } = require('../src/resource-paths')
  const text = '<script>import "@src/styles/</script><template><div/></template>'
  const index = buildIndex(text, 'vue', '/app/Page.vue')
  const references = resourceReferences(index, [])
  assert.equal(references.length, 1)
  assert.equal(references[0].end, text.indexOf('</script>'))
  assert.equal(references[0].reference, '@src/styles/')
  assert.equal(references[0].closed, false)
})

test('unfinished top-level style source attributes retain their full completion range', () => {
  const { resourceReferences } = require('../src/resource-paths')
  for (const quote of ['"', "'"]) {
    const text = `<template><div/></template>\n<style lang="scss" src=${quote}@src/styles/`
    const index = buildIndex(text, 'vue', '/app/Page.vue')
    const references = resourceReferences(index, [])
    assert.equal(references.length, 1)
    assert.equal(references[0].reference, '@src/styles/')
    assert.equal(references[0].start, text.indexOf('@src/styles/'))
    assert.equal(references[0].end, text.length)
    assert.equal(references[0].closed, false)
  }
})

test('unfinished nested style tags, comments and script strings do not become top-level resource references', () => {
  const { resourceReferences } = require('../src/resource-paths')
  for (const text of [
    '<template><div/><style src="@src/styles/',
    '<template><!-- <style src="@src/styles/',
    '<script>const fake = \'<style src="@src/styles/\''
  ]) {
    assert.deepEqual(resourceReferences(buildIndex(text, 'vue', '/app/Page.vue'), []), [], text)
  }
})
