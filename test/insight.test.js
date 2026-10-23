'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildIndex, findDefinition } = require('../src/resolver')
const { documentSymbols, declarationInfo } = require('../src/insight')

test('template locals navigate to exact destructured loop and slot declarations with shadowing', () => {
  const text = `<template><div v-for="({ name: title }, index) in rows">
    {{ title }} {{ index }}
    <X v-slot="{ row: title }">{{ title }}</X>
    <X slot-scope="{ value }">{{ value }}</X>
    {{ title }}
  </div></template><script>export default { data() { return { title: 'component', rows: [] } } }</script>`
  const index = buildIndex(text, 'vue')
  const targets = [
    [text.indexOf('{{ title }}') + 4, text.indexOf('title }, index')],
    [text.indexOf('{{ index }}') + 4, text.indexOf('index) in')],
    [text.indexOf('{{ title }}', text.indexOf('v-slot')) + 4, text.indexOf('title }"')],
    [text.indexOf('{{ value }}') + 4, text.indexOf('value }"')],
    [text.lastIndexOf('{{ title }}') + 4, text.indexOf('title }, index')]
  ]
  for (const [offset, target] of targets) {
    const hit = findDefinition(index, offset)
    assert.equal(hit?.start, target)
    assert.ok(hit.end > hit.start)
  }
})

test('outline groups component options and JSDoc fallback reads declaration comments', () => {
  const text = `<script>export default {
    data() { return { count: 1 } },
    methods: {
      /** 保存说明
       * @param {string} name 名称
       * @returns {boolean} 保存结果
       */
      save(name) { return true }
    }
  }</script>`
  const index = buildIndex(text, 'vue')
  const outline = documentSymbols(index)
  assert.deepEqual(outline.map(value => value.name), ['data', 'methods'])
  assert.equal(outline[0].children[0].name, 'count')
  assert.equal(outline[1].children[0].name, 'save')
  const info = declarationInfo(index, text.indexOf('save(name)'))
  assert.match(info.documentation, /保存说明/)
  assert.match(info.documentation, /@param \{string\} name/)
  assert.equal(info.text, 'save(name)')
})

test('JSDoc fallback includes comments attached to exported arrow variable statements', () => {
  const text = '/** 格式化说明。\n * @param {string} name 名称\n */\nexport const format = name => name.trim()'
  const index = buildIndex(text, 'javascript')
  const result = declarationInfo(index, text.indexOf('format ='))
  assert.match(result.documentation, /格式化说明/)
  assert.match(result.documentation, /@param/)
  assert.equal(result.text, 'format(name)')
})
