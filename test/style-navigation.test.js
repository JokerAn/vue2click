'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildIndex } = require('../src/resolver')
const { findStyleDefinitions } = require('../src/style-navigation')

const fileName = '/app/Page.vue'
const vue = text => buildIndex(text, 'vue', fileName)
const location = (text, selector, from = 0, file = fileName) => ({
  fileName: file,
  textSpan: { start: text.indexOf(selector, from), length: selector.length }
})

test('static class and id tokens navigate only to complete selector names in original SFC coordinates', async () => {
  const text = `<template><main class="card card-big" id='main'>
  <div class=card /></main></template>
  <style scoped>
  /* .card {} #main {} */
  .card-big { color: red; }
  .card, #main:hover { content: ".card"; background: url(".card"); --name: .card; }
  [data-name=".card"] { color: blue; }
  #mainly { color: black }
  </style>`
  const index = vue(text)
  const card = await findStyleDefinitions(index, text.indexOf('card card'))
  assert.deepEqual(card, [location(text, '.card,')].map(entry => ({
    ...entry, textSpan: { start: entry.textSpan.start, length: 5 }
  })))
  assert.deepEqual(await findStyleDefinitions(index, text.indexOf('main\'') + 1),
    [location(text, '#main', text.indexOf('.card,'))])
  assert.deepEqual(await findStyleDefinitions(index, text.indexOf('class=card') + 6), card)
  assert.deepEqual(await findStyleDefinitions(index, text.indexOf('card-big"')),
    [location(text, '.card-big', text.indexOf('<style'))])
})

test('cursor boundaries, comments, v-pre, dynamic values and unrelated attributes never trigger reads', async () => {
  for (const [template, needle, extra = 0] of [
    ['<!-- <div class="card" /> -->', 'card'],
    ['<div v-pre><span class="card" /></div>', 'card'],
    ['<div class="card" v-pre />', 'card'],
    ['<div title="card" />', 'card'],
    ['<div :class="card" />', 'card'],
    ['<div :class="{ active: card }" />', 'card'],
    ['<div :class="[{ [card]: true }]" />', 'card'],
    ['<div :id="\'card\'" />', 'card'],
    ['<div class="card other" />', 'card', 4],
    ['<div class="card" />', 'card', 4],
    ['<div id="card other" />', 'card'],
    ['<div class="c&#97;rd" />', 'c&#'],
    ['<div v-bind:class="`card`" />', 'card']
  ]) {
    const text = `<template>${template}</template><script>import './theme.css'</script><style>.card {}</style>`
    let reads = 0
    assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf(needle) + extra, {
      readFile: async () => { reads++; return '.card {}' }
    }), [], template)
    assert.equal(reads, 0, template)
  }
})

test('literal class bindings support strings, nested arrays and static object keys without inspecting conditions', async () => {
  const text = `<template><div :class="['card other', enabled, { active: enabled, 'has-error': failed }, ['child']]" /></template>
    <style>.card {} .other {} .active {} .has-error {} .child {} .enabled {} .failed {}</style>`
  for (const [needle, selector] of [
    ['card other', '.card'],
    ['other\'', '.other'],
    ['active:', '.active'],
    ['has-error', '.has-error'],
    ["child']", '.child']
  ]) {
    assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf(needle)),
      [location(text, selector)], needle)
  }
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('enabled')), [])
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('failed')), [])
})

test('CSS escaped and unicode identifiers retain selector source spans', async () => {
  const text = String.raw`<template><div class="hover:card 中文 foo" /></template>
    <style>.hover\:card {} .中文 {} .\66 oo {} .foobar {} .foo\62 ar {}</style>`
  for (const [needle, selector] of [
    ['hover:card', String.raw`.hover\:card`],
    ['中文', '.中文'],
    ['foo"', String.raw`.\66 oo`]
  ]) {
    assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf(needle)), [location(text, selector)])
  }
})

test('non-ASCII spaces remain part of the actual class or id token', async () => {
  const text = '<template><div class="foo\u00a0bar" id="main\u00a0area" /></template><style>.foo {} .foo\u00a0bar {} #main {} #main\u00a0area {}</style>'
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('foo')),
    [location(text, '.foo\u00a0bar')])
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('main')),
    [location(text, '#main\u00a0area')])
})

test('SCSS and Less nested selectors work through container rules but skip generated selectors and declarations', async () => {
  for (const lang of ['scss', 'less']) {
    const text = `<template><div class="card active child" /></template><style lang="${lang}">
      // .card {}
      $map: (card: ".card");
      @media screen { .card { &.active { .child {} } } }
      .card-more {}
      .card#{suffix} {}
      .card@{suffix} {}
      @keyframes .card { from { opacity: 0 } }
      @mixin .card { .card {} }
      .other { --custom: { .card {} }; content: '.card'; }
      </style>`
    assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('card active')),
      [location(text, '.card { &')].map(entry => ({ ...entry, textSpan: { ...entry.textSpan, length: 5 } })), lang)
    assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('active child')),
      [location(text, '.active')], lang)
    assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('child"')),
      [location(text, '.child')], lang)
  }
})

test('Less parametric mixin declarations do not masquerade as selectors', async () => {
  const text = `<template><div class="card" /></template><style lang="less">
    .card() { color: red }
    .mixin(@value) { .card {} }
    .card { color: blue }
    </style>`
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('card')),
    [location(text, '.card { color: blue')].map(entry => ({
      ...entry, textSpan: { ...entry.textSpan, length: 5 }
    })))
})

test('style src, static script imports and relative @import follow explicit files with deduplication and original offsets', async () => {
  const text = `<template><div class="card" /></template>
    <style src="./base.scss"></style>
    <style>@import "./shared.css"; .card {}</style>
    <script>
      import './theme.css'
      import theme from './theme.css'
      import type Theme from './types.css'
      const fake = "import './fake.css'"
      import('./dynamic.css')
      // import './comment.css'
    </script>`
  const files = {
    '/app/base.scss': '@import "./shared.css";\n.card { color: red }',
    '/app/shared.css': '@import "./base.scss"; .card { color: blue }',
    '/app/theme.css': '@import url("./nested/extra.css") screen;\n.card {}',
    '/app/nested/extra.css': '/* .card {} */\n.card {}'
  }
  const reads = []
  const result = await findStyleDefinitions(vue(text), text.indexOf('card'), {
    readFile: async file => { reads.push(file); return files[file] ?? null }
  })
  assert.deepEqual(result, [
    location(text, '.card'),
    location(files['/app/base.scss'], '.card', 0, '/app/base.scss'),
    location(files['/app/shared.css'], '.card', 0, '/app/shared.css'),
    location(files['/app/theme.css'], '.card', 0, '/app/theme.css'),
    location(files['/app/nested/extra.css'], '.card', files['/app/nested/extra.css'].indexOf('\n'), '/app/nested/extra.css')
  ])
  assert.deepEqual(reads, Object.keys(files))
})

test('self-closing style src loads only real top-level SFC blocks', async () => {
  const text = `<template><div class="card" /><style src="./inside.css" /></template>
    <!-- <style src="./comment.css" /> -->
    <script>const example = '<style src="./string.css" />'</script>
    <style src="./self.css" />
    <style lang="scss" src="./theme.scss"/>
    <style lang="sass" src="./unsupported.sass"/>
    <style :src="'./dynamic.css'" />`
  const reads = []
  const result = await findStyleDefinitions(vue(text), text.indexOf('card'), {
    readFile: async file => { reads.push(file); return '.card {}' }
  })
  assert.deepEqual(reads, ['/app/self.css', '/app/theme.scss'])
  assert.deepEqual(result, [
    location('.card {}', '.card', 0, '/app/self.css'),
    location('.card {}', '.card', 0, '/app/theme.scss')
  ])
})

test('imports are declaration only, relative, bounded, soft failing and do not execute project configuration', async () => {
  const text = `<template><div class="card" /></template><style>
    /* @import "./comment.css"; */
    .other { content: '@import "./string.css";'; }
    @import "https://example.com/theme.css";
    @import "//example.com/theme.css";
    @import "@/theme.css";
    @import "package/theme.css";
    @import "./missing.css";
    @import "./throw.css";
    @import "./large.css";
    @import "./theme";
    </style>`
  const reads = []
  const files = { '/app/theme.scss': '.card {}', '/app/large.css': '.card {}'.repeat(40000) }
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('card'), {
    readFile: async file => {
      reads.push(file)
      if (file.endsWith('throw.css')) {
        throw new Error('missing')
      }
      return files[file] ?? null
    }
  }), [location('.card {}', '.card', 0, '/app/theme.scss')])
  assert.deepEqual(reads, ['/app/missing.css', '/app/throw.css', '/app/large.css', '/app/theme.css', '/app/theme.scss'])
})

test('linked stylesheet traversal has source, depth and read limits', async () => {
  const start = '<template><div class="card" /></template>'
  let reads = 0
  const chain = start + '<style src="./0.css"></style>'
  const chainResult = await findStyleDefinitions(vue(chain), chain.indexOf('card'), {
    readFile: async file => {
      reads++
      const n = Number(/(\d+)\.css$/.exec(file)[1])
      return `@import "./${n + 1}.css"; .card {}`
    }
  })
  assert.equal(reads, 9)
  assert.equal(chainResult.length, 9)

  reads = 0
  const branches = start + '<style>' + Array.from({ length: 100 }, (_, i) => `@import "./${i}.css";`).join('') + '</style>'
  const branchesResult = await findStyleDefinitions(vue(branches), branches.indexOf('card'), {
    readFile: async () => { reads++; return '.card {}' }
  })
  assert.equal(reads, 31)
  assert.equal(branchesResult.length, 31)

  reads = 0
  const missing = start + '<style>' + Array.from({ length: 100 }, (_, i) => `@import "./${i}";`).join('') + '</style>'
  assert.deepEqual(await findStyleDefinitions(vue(missing), missing.indexOf('card'), {
    readFile: async () => { reads++; return null }
  }), [])
  assert.equal(reads, 64)
})

test('stylesheet byte budgets apply both per file and across linked sources', async () => {
  const start = '<template><div class="card" /></template>'
  const unicode = start + '<style src="./unicode.css"></style>'
  assert.deepEqual(await findStyleDefinitions(vue(unicode), unicode.indexOf('card'), {
    readFile: async () => '/*' + '汉'.repeat(90000) + '*/ .card {}'
  }), [])

  const total = start + '<style>' + Array.from({ length: 10 }, (_, i) => `@import "./${i}.css";`).join('') + '</style>'
  const result = await findStyleDefinitions(vue(total), total.indexOf('card'), {
    readFile: async () => '/*' + 'a'.repeat(240 * 1024) + '*/ .card {}'
  })
  assert.equal(result.length, 8)
})

test('cancellation rejects partial definitions before and after asynchronous stylesheet reads', async () => {
  const text = '<template><div class="card" /></template><style>.card {}</style><style src="./theme.css"></style>'
  let reads = 0
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('card'), {
    isCancelled: () => true,
    readFile: async () => { reads++; return '.card {}' }
  }), [])
  assert.equal(reads, 0)
  let cancelled = false
  assert.deepEqual(await findStyleDefinitions(vue(text), text.indexOf('card'), {
    isCancelled: () => cancelled,
    readFile: async () => { reads++; cancelled = true; return '.card {}' }
  }), [])
  assert.equal(reads, 1)
})
