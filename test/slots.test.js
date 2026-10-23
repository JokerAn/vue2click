'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildIndex } = require('../src/resolver')
const { describeSlots, slotContext } = require('../src/slots')
const { componentInfo } = require('../src/component-info')

const index = text => buildIndex(text, 'vue', '/app/Parent.vue')
const slots = text => describeSlots(index(`<template>${text}</template>`))

function context(markup) {
  const offset = markup.indexOf('|')
  assert.notEqual(offset, -1)
  return slotContext(index(markup.replace('|', '')), offset)
}

test('slot contracts expose static names, default slots and explicit payload keys', () => {
  assert.deepEqual(slots(`<slot/><slot name="row" :item="row" :row-index="index" title="Row"/>
    <slot name='row' v-bind:selected="selected" :item="other" />`), [
    { name: 'default', props: [] },
    { name: 'row', props: [
      { name: 'item', type: 'unknown' }, { name: 'rowIndex', type: 'unknown' },
      { name: 'title', type: 'string' }, { name: 'selected', type: 'unknown' }
    ] }
  ])
  assert.deepEqual(slots('<slot name=row :item="row"/>'), [
    { name: 'row', props: [{ name: 'item', type: 'unknown' }] }
  ])
})

test('slot extraction excludes comments, literal regions, dynamic names and spread payloads', () => {
  assert.deepEqual(slots(`<!-- <slot name="comment"/> -->
    <div v-pre><slot name="literal"/></div>
    <slot :name="name" :item="row"/>
    <slot v-bind:name="name"/>
    <slot v-bind="payload"/>
    <slot v-bind:[field]="value"/>
    <slot name="safe" :key="key" :ref="ref" @click="click" v-if="ready" />`), [
    { name: 'safe', props: [] }
  ])
})

test('slot extraction ignores script text, interpolation strings and non-HTML templates', () => {
  assert.deepEqual(slots(`{{ '<slot name="fake"/>' }}
    <textarea><slot name="text"/></textarea><slot name="actual"/>`), [{ name: 'actual', props: [] }])
  assert.deepEqual(describeSlots(index(`<script>const value = '<slot name="script"/>'</script>`)), [])
  assert.deepEqual(describeSlots(index(`<template lang="pug">slot(name="pug")</template>`)), [])
  assert.deepEqual(describeSlots(index(`<template src="./view.html"><slot/></template>`)), [])
})

test('quoted comparisons and markup strings stay inside their attributes', () => {
  assert.deepEqual(slots(`<div title="<slot name='fake'/>"/><slot :item="count < 10" name="row"/>`), [
    { name: 'row', props: [{ name: 'item', type: 'unknown' }] }
  ])
  assert.equal(context(`<template><Child :value="count < 10" #ro|/></template>`).tag, 'Child')
})

test('slot name contexts use the enclosing component and exact name span', () => {
  for (const syntax of ['#he|ader', 'v-slot:he|ader']) {
    const markup = `<template><Child><template ${syntax}="{ row }"/></Child></template>`
    const result = context(markup)
    const start = markup.indexOf('header'.slice(0, 2))
    assert.deepEqual(result, { kind: 'slot', tag: 'Child', slotName: 'header',
      prefix: 'he', start, end: start + 'header'.length })
  }
  assert.equal(context('<template><Child #|/></template>').prefix, '')
  assert.equal(context('<template><Child v-slot:|/></template>').kind, 'slot')
})

test('object slot parameter contexts expose keys and exclude previously bound properties', () => {
  const result = context(`<template><Child><template #row="{ item: value, selected = false, ind|ex }"/></Child></template>`)
  assert.equal(result.kind, 'slotProp')
  assert.equal(result.tag, 'Child')
  assert.equal(result.slotName, 'row')
  assert.equal(result.prefix, 'ind')
  assert.deepEqual(result.used, ['item', 'selected'])
  assert.equal(result.end - result.start, 'index'.length)
  const empty = context(`<template><Child><template #row="{ item, | }"/></Child></template>`)
  assert.deepEqual(empty.used, ['item'])
  assert.equal(empty.start, empty.end)
})

test('direct component v-slot parameter bindings target the default slot', () => {
  for (const syntax of ['v-slot', 'v-slot:default', '#default']) {
    const result = context(`<template><Child ${syntax}="{ it| }"/></template>`)
    assert.equal(result.kind, 'slotProp')
    assert.equal(result.tag, 'Child')
    assert.equal(result.slotName, 'default')
    assert.equal(result.prefix, 'it')
  }
})

test('legacy static slot names and scoped-slot destructuring remain supported', () => {
  const named = context(`<template><Child><template slot="ro|w" slot-scope="scope"/></Child></template>`)
  assert.equal(named.kind, 'slot')
  assert.equal(named.tag, 'Child')
  assert.equal(named.prefix, 'ro')
  const scope = context(`<template><Child><div slot="row" slot-scope="{ it| }"/></Child></template>`)
  assert.equal(scope.kind, 'slotProp')
  assert.equal(scope.slotName, 'row')
  assert.equal(context(`<template><Child><template scope="{ it| }"/></Child></template>`).slotName, 'default')
})

test('slot contexts recover while the attribute, quote or tag is unfinished', () => {
  for (const markup of [
    '<template><Child><template #ro|',
    '<template><Child><template v-slot:ro|</template>',
    '<template><Child #row="{ it|',
    '<template><Child><template #row="{ it|</template>'
  ]) {
    const result = context(markup)
    assert.ok(result, markup)
    assert.equal(result.tag, 'Child', markup)
  }
})

test('slot contexts exclude comments, v-pre, native and dynamic owners', () => {
  for (const markup of [
    '<template><!-- <Child #ro|/> --></template>',
    '<template><div v-pre><Child #ro|/></div></template>',
    '<template><Child v-pre #ro|/></template>',
    '<template><div #ro|/></template>',
    '<template><component :is="target"><template #ro|/></component></template>',
    '<template><Child :is="target"><template #ro|/></Child></template>',
    '<template><Child><template #[ro|]/></Child></template>',
    '<template><Child><template v-slot:[ro|]/></Child></template>',
    '<template><Child><template :slot="name" slot-scope="{ it| }"/></Child></template>'
  ]) {
    assert.equal(context(markup), null, markup)
  }
})

test('slot property completion does not enter aliases, nested patterns or binding expressions', () => {
  for (const markup of [
    '<template><Child #row="it|"/></template>',
    '<template><Child #row="{ item: ro| }"/></template>',
    '<template><Child #row="{ item = fal| }"/></template>',
    '<template><Child #row="{ item: { na| } }"/></template>',
    '<template><Child #row="{ ...re| }"/></template>',
    '<template><Child #row="{ item }" :value="it|"/></template>',
    '<template><Child :value="row.it|"/></template>',
    '<template><Child @click="it|"/></template>'
  ]) {
    assert.equal(context(markup), null, markup)
  }
})

test('nested components select their own slot owner without leaking adjacent contexts', () => {
  const result = context(`<template><Outer><Inner><template #row="{ it| }"/></Inner></Outer></template>`)
  assert.equal(result.tag, 'Inner')
  assert.equal(context('<template><Outer><div><template #ro|/></div></Outer></template>'), null)
  assert.equal(context('<template><Child #row="{}"/>{{ it| }}</template>'), null)
})

test('component descriptions append only the resolved component template slots and preserve mixins', async () => {
  const files = {
    '/app/Child.vue': `<template><slot name="row" :item="row"/></template><script>
      import mixin from './mixin'; export default { mixins: [mixin], props: ['own'], emits: ['save'] }</script>`,
    '/app/mixin.vue': `<template><slot name="not-inherited"/></template><script>export default { props: ['inherited'] }</script>`
  }
  const parent = index(`<script>import Child from './Child'; export default { components: { Child } }</script>`)
  const result = await componentInfo(parent, 'Child', {
    async resolveModule(specifier) {
      return specifier === './Child' ? '/app/Child.vue' : '/app/mixin.vue'
    },
    async loadIndex(file) {
      return buildIndex(files[file], 'vue', file)
    }
  })
  assert.deepEqual(result.props.map(prop => prop.name), ['inherited', 'own'])
  assert.deepEqual(result.events.map(event => event.name), ['save'])
  assert.deepEqual(result.slots, [{ name: 'row', props: [{ name: 'item', type: 'unknown' }] }])
})
