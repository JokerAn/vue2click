'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildIndex, findDefinition } = require('../src/resolver')
const { documentSymbols, declarationInfo, staticHoverInfo } = require('../src/insight')

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

test('JSDoc does not leak an outer function comment onto an undocumented local variable', () => {
  const text = `/** 提交订单 */
function submitOrder() {
  const result = 1
  return result
}`
  const index = buildIndex(text, 'javascript')
  const result = declarationInfo(index, text.indexOf('result ='))
  assert.equal(result, null)
})

test('JSDoc parameter hover extracts the matching param description', () => {
  const text = `/**
 * 查询订单
 * @param {string} orderId 订单编号
 * @param {boolean} force 是否强制刷新
 * @returns {Promise<Object>} 订单结果
 */
function queryOrder(orderId, force) {
  return orderId && force
}`
  const index = buildIndex(text, 'javascript')
  const usage = text.indexOf('return orderId') + 'return '.length + 1
  const hit = findDefinition(index, usage)
  const result = declarationInfo(index, hit.start)
  assert.equal(result.parameter, 'orderId')
  assert.equal(result.documentation, '订单编号')
  assert.equal(result.type, 'string')
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

test('static hover info prefers a resolved declaration comment before project quick info', () => {
  const text = `/** 保存订单 */
function saveOrder() {
  return true
}`
  const index = buildIndex(text, 'javascript')
  const hit = findDefinition(index, text.indexOf('saveOrder()') + 1)
  const result = staticHoverInfo(index, text.indexOf('saveOrder()') + 1, {
    index,
    start: hit.start
  })
  assert.equal(result.documentation, '保存订单')
  assert.equal(result.text, 'saveOrder()')
})

test('arrow parameters retain nested JSDoc types, multiline descriptions and defaults', () => {
  const text = `/**
 * @param {{id: number}} row Row identifier.
 * Continues on the next line.
 * @param {Function} [done=() => {}] Completion callback.
 */
const save = (row, done = () => {}) => { done(row.id) }`
  const index = buildIndex(text, 'javascript')
  for (const [name, type, description] of [
    ['row', '{id: number}', 'Row identifier.\nContinues on the next line.'],
    ['done', 'Function', 'Completion callback.']
  ]) {
    const offset = text.indexOf(name, text.indexOf('const save'))
    const info = declarationInfo(index, offset)
    assert.equal(info?.parameter, name)
    assert.equal(info?.type, type)
    assert.equal(info?.documentation, description)
  }
})
