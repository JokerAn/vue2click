'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { buildIndex, findDefinition, sourceText } = require('../src/resolver')

function check(src, needle, target, language = 'javascript', nth = 0) {
  const index = buildIndex(src, language)
  const start = src.indexOf(needle)
  assert.notEqual(start, -1, 'missing reference: ' + needle)
  const offset = start + needle.indexOf(target) + 1 + nth
  const hit = findDefinition(index, offset)
  assert.ok(hit, 'missing definition: ' + needle)
  return src.slice(hit.start, hit.end)
}

const component = `<template><div>{{ value }}</div></template>
<script>
const globalValue = 1
export default {
  data() { return { value: 1, other: 2 } },
  computed: { computedValue() { return this.value } },
  methods: {
    async createdInit(reason) { const local = reason; return local },
    call() { return this.createdInit(this.value) + this.computedValue + globalValue }
  }
}
</script>
<style>.a{color:red}</style>`

test('Vue 2 methods, data and computed properties resolve at exact source offsets', () => {
  assert.equal(check(component, 'this.createdInit(this.value)', 'createdInit', 'vue'), 'createdInit')
  assert.equal(check(component, 'this.createdInit(this.value)', 'value', 'vue'), 'value')
  assert.equal(check(component, 'this.computedValue + globalValue', 'computedValue', 'vue'), 'computedValue')
  assert.equal(check(component, '+ globalValue', 'globalValue', 'vue'), 'globalValue')
  assert.equal(findDefinition(buildIndex(component, 'vue'), component.indexOf('{{ value }}') + 3), null)
  assert.equal(sourceText(component, 'vue').length, component.length)
})

test('functions, var, let, const and parameters follow lexical scope/shadowing', () => {
  const src = `const x = 1; function outer(p) {
    var v = 2; let a = 3;
    { const x = 4; x; let a = 5; a }
    return x + v + a + p;
  }
  outer(3)`
  const index = buildIndex(src, 'javascript')
  const outerHit = findDefinition(index, src.lastIndexOf('outer(3)') + 2)
  assert.equal(src.slice(outerHit.start, outerHit.end), 'outer')
  assert.equal(findDefinition(index, src.indexOf('x; let a')).start, src.indexOf('x = 4'))
  assert.equal(findDefinition(index, src.indexOf('return x') + 'return '.length).start, src.indexOf('x = 1'))
  assert.equal(findDefinition(index, src.indexOf('+ v +') + 2).start, src.indexOf('v = 2'))
  assert.equal(findDefinition(index, src.indexOf('+ a +') + 2).start, src.indexOf('a = 3'))
  assert.equal(findDefinition(index, src.indexOf('+ p;') + 2).start, src.indexOf('p)'))
})

test('unrelated object properties and unbound identifiers do not produce misleading jumps', () => {
  const src = 'const value = 1; obj.value; unknown();'
  const index = buildIndex(src, 'javascript')
  assert.equal(findDefinition(index, src.indexOf('obj.value') + 'obj.'.length + 1), null)
  assert.equal(findDefinition(index, src.indexOf('unknown') + 2), null)
})

test('plain object and TypeScript class this.method go to their declaration', () => {
  const obj = 'const item = { doIt() { return this.render() }, render() { return 1 } }'
  assert.equal(check(obj, 'this.render()', 'render'), 'render')
  const cls = 'class Item { value = 2; render() { return this.value } }'
  assert.equal(check(cls, 'this.value', 'value', 'typescript'), 'value')
})

test('this.foo initialized by assignment is treated as a declaration', () => {
  const src = 'function Widget() { this.current = 1; this.show = () => this.current }'
  const idx = buildIndex(src, 'javascript')
  const hit = findDefinition(idx, src.lastIndexOf('this.current') + 6)
  assert.equal(hit.start, src.indexOf('current'))
})

test('this assignments in unrelated classes are not reused', () => {
  const src = 'class A { constructor() { this.foo = 1 } } class B { run() { this.foo() } }'
  assert.equal(findDefinition(buildIndex(src, 'typescript'), src.lastIndexOf('this.foo') + 6), null)
})

test('unicode does not shift Vue script offsets', () => {
  const src = '<template>🧩</template><script>const foo = 1; foo</script>'
  assert.equal(sourceText(src, 'vue').length, src.length)
  assert.equal(findDefinition(buildIndex(src, 'vue'), src.lastIndexOf('foo') + 1).start, src.indexOf('foo'))
})

test('real project regression: this.createdInit resolves to method when fixture exists', t => {
  const file = '/Users/anshunli1/jd/jdGit/product/web/apply-claim/src/views/apply/index.vue'
  if (!fs.existsSync(file)) return t.skip('original Vue 2 project is not available')
  const src = fs.readFileSync(file, 'utf8')
  const index = buildIndex(src, 'vue', file)
  const call = 'return this.createdInit('
  const start = src.indexOf(call)
  assert.ok(start >= 0, `missing call: ${call}`)
  const hit = findDefinition(index, start + 'return this.created'.length)
  assert.ok(hit, 'Vetur returned [] for this case')
  assert.equal(src.slice(hit.start, hit.end), 'createdInit')
  assert.equal(
    src.slice(0, hit.start).split('\n').length,
    src.slice(0, src.indexOf('async createdInit(')).split('\n').length,
    'must point at the createdInit declaration'
  )
  assert.equal(check(src, "this.failEntryInitF('原因配置加载失败，请重试')", 'failEntryInitF', 'vue'), 'failEntryInitF')
})

test('Vue watch object handlers resolve instance members without leaking other nested objects', () => {
  for (const handler of [
    'handler: function () { return this.load() }',
    'handler() { return this.load() }',
    'handler: function () { const later = () => this.load(); return later() }'
  ]) {
    const src = `export default { watch: { status: { ${handler}, deep: true } }, methods: { load() {} } }`
    const hit = findDefinition(buildIndex(src, 'javascript'), src.indexOf('this.load()') + 'this.'.length + 2)
    assert.equal(hit?.start, src.lastIndexOf('load() {}'), handler)
  }
  const ordinary = 'export default { methods: { load() {}, run() { const nested = { handler: function () { return this.load() } }; return nested.handler() } } }'
  assert.equal(findDefinition(buildIndex(ordinary, 'javascript'), ordinary.indexOf('this.load()') + 'this.'.length + 2), null)
  const unrelatedWatch = 'const plain = { watch: { status: { handler: function () { return this.load() } } }, methods: { load() {} } }'
  assert.equal(findDefinition(buildIndex(unrelatedWatch, 'javascript'), unrelatedWatch.indexOf('this.load()') + 'this.'.length + 2), null)
})

test('real project regression: getAiShareInfo in watch handler resolves to method when fixture exists', t => {
  const file = '/Users/anshunli1/jd/jdGit/product/web/apply-claim/src/views/apply/index.vue'
  if (!fs.existsSync(file)) return t.skip('original Vue 2 project is not available')
  const src = fs.readFileSync(file, 'utf8')
  const index = buildIndex(src, 'vue', file)
  for (const call of ['this.getAiShareInfo().then', 'this.getAiShareInfo(retryCount + 1)']) {
    const at = src.indexOf(call)
    assert.ok(at >= 0, `missing call: ${call}`)
    const hit = findDefinition(index, at + 'this.'.length + 2)
    assert.ok(hit, `missing definition for ${call}`)
    assert.equal(src.slice(hit.start, hit.end), 'getAiShareInfo', call)
    assert.equal(
      src.slice(0, hit.start).split('\n').length,
      src.slice(0, src.indexOf('getAiShareInfo(retryCount = 0)')).split('\n').length,
      call
    )
  }
})

test('this property assignments are found within the same Vue instance or class', () => {
  const cases = [
    ['export default { methods: { init() { this.tmp = 1; return this.tmp } } }', 'this.tmp = 1', 'return this.tmp', 'javascript'],
    ['export default { methods: { init() { this.tmp = 1 }, run() { return this.tmp } } }', 'this.tmp = 1', 'return this.tmp', 'javascript'],
    ['class A { constructor() { this.tmp = 1 } run() { return this.tmp } }', 'this.tmp = 1', 'return this.tmp', 'typescript']
  ]
  for (const [src, declaration, reference, language] of cases) {
    const at = src.indexOf(reference) + reference.lastIndexOf('tmp')
    const hit = findDefinition(buildIndex(src, language), at)
    assert.equal(hit?.start, src.indexOf(declaration) + 'this.'.length, reference)
  }
})

test('nested object methods bind this to their object, never an outer Vue component', () => {
  const src = 'export default { methods: { other() {}, run() { const nested = { go() { return this.other() }, other() {} }; return nested.go() } } }'
  const at = src.indexOf('this.other()') + 'this.'.length
  const hit = findDefinition(buildIndex(src, 'javascript'), at)
  assert.equal(hit?.start, src.indexOf('other() {}', src.indexOf('const nested')))

  const missing = src.replace(', other() {} };', ' };')
  assert.equal(findDefinition(buildIndex(missing, 'javascript'), missing.indexOf('this.other()') + 'this.'.length), null)

  const nestedFn = 'export default { methods: { other() {}, run() { function f() { return this.other() }; return f() } } }'
  assert.equal(findDefinition(buildIndex(nestedFn, 'javascript'), nestedFn.indexOf('this.other()') + 'this.'.length), null)

  const lexicalArrow = 'export default { methods: { other() {}, run() { const f = () => this.other(); return f() } } }'
  assert.equal(findDefinition(buildIndex(lexicalArrow, 'javascript'), lexicalArrow.indexOf('this.other()') + 'this.'.length)?.start, lexicalArrow.indexOf('other() {}'))
})

test('a Vue watch handler is not a property definition for this.xxx', () => {
  const src = 'export default { watch: { status() {} }, methods: { run() { return this.status } } }'
  assert.equal(findDefinition(buildIndex(src, 'javascript'), src.indexOf('this.status') + 'this.'.length), null)
})

test('dynamic this assignments do not leak from a Vue method into nested objects', () => {
  const src = 'export default { methods: { init() { this.tmp = 1; const nested = { read() { return this.tmp } }; return nested.read() } } }'
  assert.equal(findDefinition(buildIndex(src, 'javascript'), src.indexOf('return this.tmp') + 'return this.'.length), null)
})

test('Vue data takes precedence over an identically named watch handler', () => {
  const src = 'export default { data() { return { status: 1 } }, watch: { status() {} }, methods: { run() { return this.status } } }'
  const hit = findDefinition(buildIndex(src, 'javascript'), src.indexOf('this.status') + 'this.'.length)
  assert.equal(hit?.start, src.indexOf('status: 1'))
})

test('a let/const this alias resolves instance members exactly like this', () => {
  const src = `export default {
  methods: {
    goBackPop() {},
    appBack() {},
    mounted() {
      const me = this
      const params = {
        onClickBtnBack: (res) => {
          if (window.location.href.includes('claim/apply-claim/process')) {
            me.goBackPop()
          } else {
            me.appBack()
          }
        }
      }
      return params
    }
  }
}`
  const index = buildIndex(src, 'javascript')
  const pop = findDefinition(index, src.indexOf('me.goBackPop()') + 'me.'.length + 1)
  assert.equal(src.slice(pop.start, pop.end), 'goBackPop')
  const back = findDefinition(index, src.indexOf('me.appBack()') + 'me.'.length + 1)
  assert.equal(src.slice(back.start, back.end), 'appBack')

  // Clicking the alias itself still points at its declaration.
  const alias = findDefinition(index, src.indexOf('me.goBackPop()') + 1)
  assert.equal(src.slice(alias.start, alias.end), 'me')
  assert.equal(alias.start, src.indexOf('me = this'))
})

test('this aliases respect scope and shadowing, and never bind other receivers', () => {
  const leak = 'export default { methods: { load() {}, a() { const me = this; me.load() }, b() { me.load() } } }'
  assert.equal(findDefinition(buildIndex(leak, 'javascript'), leak.lastIndexOf('me.load()') + 3), null)

  const shadow = 'export default { methods: { load() {}, run() { const me = this; { const me = {}; me.load() } } } }'
  assert.equal(findDefinition(buildIndex(shadow, 'javascript'), shadow.lastIndexOf('me.load()') + 3), null)

  const plain = 'const me = { load() {} }; me.load()'
  assert.equal(findDefinition(buildIndex(plain, 'javascript'), plain.lastIndexOf('me.load()') + 3), null)

  const self = 'export default { methods: { load() {}, run() { const self = this; self.load() } } }'
  const hit = findDefinition(buildIndex(self, 'javascript'), self.indexOf('self.load()') + 'self.'.length + 1)
  assert.equal(self.slice(hit.start, hit.end), 'load')

  const casted = 'export default { methods: { load() {}, run() { const me = this as any; me.load() } } }'
  const castHit = findDefinition(buildIndex(casted, 'typescript'), casted.indexOf('me.load()') + 'me.'.length + 1)
  assert.equal(casted.slice(castHit.start, castHit.end), 'load')
})

test('real project regression: let me = this alias resolves in ai-process', t => {
  const file = '/Users/anshunli1/jd/jdGit/product/web/apply-claim/src/views/ai-code/ai-process/index.vue'
  if (!fs.existsSync(file)) return t.skip('original Vue 2 project is not available')
  const src = fs.readFileSync(file, 'utf8')
  const index = buildIndex(src, 'vue', file)
  const at = src.indexOf('me.goBackPop()')
  assert.ok(at >= 0, 'missing me.goBackPop() call')
  const hit = findDefinition(index, at + 'me.'.length + 1)
  assert.ok(hit, 'let me = this receiver was not resolved')
  assert.equal(src.slice(hit.start, hit.end), 'goBackPop')
  assert.equal(src.slice(0, hit.start).split('\n').length, 589)
  const back = findDefinition(index, src.indexOf('me.appBack()') + 'me.'.length + 1)
  assert.equal(src.slice(back.start, back.end), 'appBack')
})
