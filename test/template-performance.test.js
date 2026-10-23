'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildTemplateIndex } = require('../src/template')
const { buildIndex, findDefinition } = require('../src/resolver')

test('template syntax trees are built on demand and identical expressions share parsing', () => {
  let parses = 0
  const template = buildTemplateIndex(`<template>
    <button @click="gotoPage(1)" /><button @click="gotoPage(1)" />
    <p>{{ gotoPage(1) }}</p><div :title="value" />
  </template>`, source => { parses++; return buildIndex(source, 'javascript') })
  assert.equal(parses, 0, 'collecting template ranges must not parse every expression')
  const [first, second, interpolation, binding] = template.expressions
  const index = first.index
  assert.equal(parses, 1)
  assert.equal(first.index, index, 'repeat queries reuse the first parse')
  assert.equal(second.index, index, 'identical handlers share a syntax tree')
  assert.equal(parses, 1)
  assert.notEqual(interpolation.index, index, 'statement and value wrappers have different syntax')
  assert.equal(parses, 2)
  assert.ok(binding.index)
  assert.equal(parses, 3)
})

test('shared expression trees keep per-occurrence source offsets and template local scopes', () => {
  const source = `<template>
    <p>{{ item }}</p><p v-for="item in items">{{ item }}</p>
    <button @click="ready &amp;&amp; gotoPage(1)" />
    <button @click="ready && gotoPage(1)" />
    <button @click="items.map(item =&gt; gotoPage(item))" />
    <button @click="items.map(item => gotoPage(item))" />
  </template><script>export default {
    data() { return { item: 1, items: [], ready: true } }, methods: { gotoPage(type) {} }
  }</script>`
  const index = buildIndex(source, 'vue')
  const itemReferences = [...source.matchAll(/\{\{ item \}\}/g)]
  assert.equal(findDefinition(index, itemReferences[0].index + 4)?.start, source.indexOf('item: 1'))
  assert.equal(findDefinition(index, itemReferences[1].index + 4)?.start, source.indexOf('item in items'),
    'v-for alias must resolve to its own declaration')
  const repeated = index.templates.filter(exp => source.slice(exp.start, exp.end).trim() === 'item')
  assert.equal(repeated[0].index, repeated[1].index)
  for (const match of source.matchAll(/gotoPage\(1\)/g)) {
    assert.equal(findDefinition(index, match.index + 1)?.start, source.indexOf('gotoPage(type)'))
  }
  for (const match of source.matchAll(/items\.map\(item (?:=&gt;|=>) gotoPage\(item\)\)/g)) {
    const reference = match.index + match[0].lastIndexOf('item')
    const hit = findDefinition(index, reference + 1)
    assert.equal(hit?.start, match.index + 'items.map('.length, 'each occurrence points to its own arrow parameter')
    assert.equal(source.slice(hit.start, hit.end), 'item')
  }
})

test('lazy expression sharing expires when a Vue document is rebuilt', () => {
  const source = `<template><button @click="gotoPage(1)" /></template>
<script>export default { methods: { gotoPage(type) {} } }</script>`
  const before = buildIndex(source, 'vue')
  const edited = source.replace('methods:', '\n\nmethods:')
  const after = buildIndex(edited, 'vue')
  const offset = source.indexOf('gotoPage(1)') + 1
  assert.equal(findDefinition(before, offset)?.start, source.indexOf('gotoPage(type)'))
  assert.equal(findDefinition(after, offset)?.start, edited.indexOf('gotoPage(type)'))
  assert.notEqual(before.templates[0].index, after.templates[0].index)
})
