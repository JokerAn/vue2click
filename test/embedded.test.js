'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createEmbeddedService } = require('../src/embedded')

function fakeDocument(text, version = 1) {
  return {
    version,
    uri: { toString: () => 'file:///sample.vue' },
    offsetAt(position) { return position.offset },
    positionAt(offset) { return { offset } },
    getText() { return text }
  }
}

function services(calls) {
  const html = {
    parseHTMLDocument() { calls.html++ ; return {} }
  }
  const stylesheet = language => ({
    parseStylesheet() { calls[language]++ ; return {} }
  })
  return { html, styles: { css: stylesheet('css'), scss: stylesheet('scss'), less: stylesheet('less') } }
}

test('embedded lookup parses only the block containing the cursor', () => {
  const text = '<template><div /></template>\n<script>const value = 1</script>\n<style lang="scss">.x { color: red }</style>'
  const template = { tag: 'template', start: 0, end: 29, external: false }
  const script = { tag: 'script', start: 38, end: 52, external: false }
  const style = { tag: 'style', lang: 'scss', start: 80, end: 98, external: false }
  const index = { text, blocks: [template, script, style], templates: [] }
  const calls = { html: 0, css: 0, scss: 0, less: 0 }
  const embedded = createEmbeddedService(services(calls))
  const document = fakeDocument(text)

  assert.equal(embedded.at(document, index, { offset: 42 }), undefined)
  assert.deepEqual(calls, { html: 0, css: 0, scss: 0, less: 0 })

  const result = embedded.at(document, index, { offset: 90 })
  assert.equal(result?.language, 'scss')
  assert.deepEqual(calls, { html: 0, css: 0, scss: 1, less: 0 })
})

test('rebuilding a static index at the same document version reuses embedded block parses', () => {
  const text = '<style>.x { color: red }</style>'
  const block = { tag: 'style', start: 7, end: text.indexOf('</style>') }
  const calls = { html: 0, css: 0, scss: 0, less: 0 }
  const embedded = createEmbeddedService(services(calls))
  const document = fakeDocument(text)
  for (let index = 0; index < 5; index++) {
    const result = embedded.at(document, { text, blocks: [{ ...block }], templates: [] }, { offset: 9 })
    assert.equal(result.language, 'css')
  }
  assert.equal(calls.css, 1, 'LRU eviction of the static index must not grow duplicate embedded entries')
  assert.equal(embedded.entries(document, { text, blocks: [{ ...block }], templates: [] }).length, 1)
})
