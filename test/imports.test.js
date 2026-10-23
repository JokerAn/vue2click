'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildIndex, findDefinition } = require('../src/resolver')
const { findImportedDefinition } = require('../src/imports')

function fixture(source, files) {
  const fileName = '/project/src/Parent.vue'
  const offset = source.indexOf('|')
  assert.ok(offset >= 0)
  const text = source.replace('|', '')
  const index = buildIndex(text, 'vue', fileName)
  const sources = new Map(Object.entries(files).map(([name, text]) =>
    [path.resolve('/project/src', name), text]))
  const calls = { resolves: 0, loads: 0 }
  const context = {
    isCancelled: () => false,
    async resolveModule(specifier, from) {
      calls.resolves++
      const absolute = path.resolve(path.dirname(from), specifier)
      return [absolute, absolute + '.js', absolute + '.ts', absolute + '.vue', path.join(absolute, 'index.js')]
        .find(candidate => sources.has(candidate)) || null
    },
    async loadIndex(file) {
      calls.loads++
      const text = sources.get(file)
      return text === undefined ? null : buildIndex(text,
        file.endsWith('.vue') ? 'vue' : file.endsWith('.ts') ? 'typescript' : 'javascript', file)
    }
  }
  return { index, offset, sources, context, calls }
}

async function assertTarget(source, files, expectedFile, needle) {
  const f = fixture(source, files)
  const hit = await findImportedDefinition(f.index, f.offset, f.context)
  assert.ok(hit, source)
  assert.equal(hit.fileName, path.resolve('/project/src', expectedFile))
  const text = f.sources.get(hit.fileName)
  assert.equal(text.slice(hit.start, hit.end), needle)
  return f
}

test('named imports, aliases and namespace members resolve functions, variables and destructured exports', async () => {
  const files = { 'utils.js': 'export function report() {} ; export const count = 1; export const { foo } = obj' }
  for (const source of [
    `<script>import { report } from './utils'; rep|ort()</script>`,
    `<script>import { report as run } from './utils'; ru|n()</script>`,
    `<script>import { rep|ort as run } from './utils'; run()</script>`,
    `<script>import { report as ru|n } from './utils'; run()</script>`,
    `<script>import * as tools from './utils'; tools.rep|ort()</script>`
  ]) {
    await assertTarget(source, files, 'utils.js', 'report')
  }
  await assertTarget(`<script>import { count } from './utils'; console.log(co|unt)</script>`, files, 'utils.js', 'count')
  await assertTarget(`<script>import { foo } from './utils'; console.log(fo|o)</script>`, files, 'utils.js', 'foo')
})

test('default exports resolve named/anonymous functions, classes, expressions and imported bindings', async () => {
  for (const [source, expected] of [
    ['export default function report() {}', 'report'],
    ['export default class Client {}', 'Client'],
    ['export default function () {}', 'export default function () {}'],
    ['const report = () => {}; export default report', 'report'],
    ['export default () => 1', '() => 1']
  ]) {
    await assertTarget(`<script>import run from './utils'; ru|n()</script>`, { 'utils.js': source }, 'utils.js', expected)
  }
  await assertTarget(`<script>import run from './barrel'; ru|n()</script>`, {
    'barrel.js': `import { report } from './utils'; export default report`,
    'utils.js': 'export function report() {}'
  }, 'utils.js', 'report')
})

test('local export lists and named/default/star re-exports follow the original declaration', async () => {
  const utils = 'export function report() {}'
  for (const barrel of [
    `export { report as run } from './utils'`,
    `import { report } from './utils'; export { report as run }`,
    `export * from './second'`
  ]) {
    await assertTarget(`<script>import { run } from './barrel'; ru|n()</script>`, {
      'barrel.js': barrel, 'second.js': `export { report as run } from './utils'`, 'utils.js': utils
    }, 'utils.js', 'report')
  }
  await assertTarget(`<script>import { run } from './barrel'; ru|n()</script>`, {
    'barrel.js': `export { default as run } from './utils'`, 'utils.js': 'export default function report() {}'
  }, 'utils.js', 'report')
  await assertTarget(`<script>import run from './barrel'; ru|n()</script>`, {
    'barrel.js': `export { report as default } from './utils'`, 'utils.js': utils
  }, 'utils.js', 'report')
  await assertTarget(`<script>import { run } from './utils'; ru|n()</script>`, {
    'utils.js': 'function report() {}; export { report as run }'
  }, 'utils.js', 'report')
})

test('local shadowing, ordinary property keys and unsupported dynamic access never probe imported modules', async () => {
  for (const source of [
    `<script>import { report } from './utils'; function call(report) { rep|ort() }</script>`,
    `<script>import * as tools from './utils'; function call(tools) { tools.rep|ort() }</script>`,
    `<script>import { report } from './utils'; const obj = { rep|ort: 1 }</script>`,
    `<script>import { report } from './utils'; const obj = { rep|ort() {} }</script>`,
    `<script>import { report } from './utils'; other.rep|ort()</script>`,
    `<script>import * as tools from './utils'; tools['rep|ort']()</script>`,
    `<script>import type { report } from './utils'; rep|ort()</script>`,
    `<script>import { type report } from './utils'; rep|ort()</script>`,
    `<template>report|</template><script>import { report } from './utils'</script>`
  ]) {
    const f = fixture(source, { 'utils.js': 'export function report() {}' })
    assert.equal(await findImportedDefinition(f.index, f.offset, f.context), null, source)
    assert.deepEqual(f.calls, { resolves: 0, loads: 0 })
  }
  const f = fixture(`<script>import { report } from './utils'; function call(report) { rep|ort() }</script>`, {})
  const hit = findDefinition(f.index, f.offset)
  assert.ok(hit)
  assert.equal(hit.start, f.index.text.indexOf('report)'))
})

test('export-star conflicts, default exclusion and non-exported declarations do not return misleading definitions', async () => {
  for (const files of [
    { 'barrel.js': `export * from './a'; export * from './b'`, 'a.js': 'export function run() {}', 'b.js': 'export function run() {}' },
    { 'barrel.js': 'function run() {}' },
    { 'barrel.js': 'export default function run() {}' }
  ]) {
    const f = fixture(`<script>import { run } from './barrel'; ru|n()</script>`, files)
    assert.equal(await findImportedDefinition(f.index, f.offset, f.context), null)
  }
  const noDefault = fixture(`<script>import run from './barrel'; ru|n()</script>`, {
    'barrel.js': `export * from './utils'`, 'utils.js': 'export default function run() {}'
  })
  assert.equal(await findImportedDefinition(noDefault.index, noDefault.offset, noDefault.context), null)
})

test('cyclic/deep re-exports, missing modules, failures and cancellation are bounded and recoverable', async () => {
  const cyclic = fixture(`<script>import { run } from './a'; ru|n()</script>`, {
    'a.js': `export * from './b'`, 'b.js': `export * from './a'`
  })
  assert.equal(await findImportedDefinition(cyclic.index, cyclic.offset, cyclic.context), null)
  assert.ok(cyclic.calls.loads <= 2)
  const deepFiles = Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
    [`a${i}.js`, i === 39 ? 'export function run() {}' : `export * from './a${i + 1}'`]))
  const deep = fixture(`<script>import { run } from './a0'; ru|n()</script>`, deepFiles)
  assert.equal(await findImportedDefinition(deep.index, deep.offset, deep.context), null)
  assert.ok(deep.calls.loads <= 25)
  const f = fixture(`<script>import { run } from './missing'; ru|n()</script>`, {})
  assert.equal(await findImportedDefinition(f.index, f.offset, f.context), null)
  assert.equal(await findImportedDefinition(f.index, f.offset, {
    ...f.context, async resolveModule() { throw new Error('unreadable') }
  }), null)
  assert.equal(await findImportedDefinition(f.index, f.offset, { ...f.context, isCancelled: () => true }), null)
})
