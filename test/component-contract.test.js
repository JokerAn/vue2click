'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildIndex } = require('../src/resolver')
const { componentOptions } = require('../src/components')
const { componentInfo, describeComponent } = require('../src/component-info')

function fixture(script, extra = {}) {
  const parent = `<script>import Child from './Child.vue'; export default { components: { Child } }</script>`
  const files = { '/app/Parent.vue': parent, '/app/Child.vue': script, ...extra }
  const loads = []
  const resolutions = []
  const context = {
    async resolveModule(specifier, from) {
      resolutions.push([specifier, from])
      const base = path.resolve(path.dirname(from), specifier)
      return [base, base + '.ts', base + '.vue', base + '.js', path.join(base, 'index.ts')]
        .find(file => Object.hasOwn(files, file)) || null
    },
    async loadIndex(file) {
      loads.push(file)
      return Object.hasOwn(files, file)
        ? buildIndex(files[file], file.endsWith('.vue') ? 'vue' : file.endsWith('.js') ? 'javascript' : 'typescript', file)
        : null
    }
  }
  return {
    files, loads, resolutions, context,
    info: overrides => componentInfo(buildIndex(parent, 'vue', '/app/Parent.vue'), 'Child', { ...context, ...overrides })
  }
}

const values = prop => prop.values.map(value => value.value)
const byName = info => Object.fromEntries(info.props.map(prop => [prop.name, prop]))

test('component contracts follow local aliases, interface inheritance and intersections', async () => {
  const f = fixture(`<script setup lang="ts">
    type Size = ('small' | 'large')
    interface Base { /** Display size. */ size?: Size; title: string }
    type Extra = { active?: boolean }
    interface Props extends Base { mode: 'edit' | 'view' }
    type Contract = Props & Extra
    defineProps<Contract>()
  </script>`)
  const props = byName(await f.info())
  assert.deepEqual(Object.keys(props).sort(), ['active', 'mode', 'size', 'title'])
  assert.deepEqual(values(props.size), ['small', 'large'])
  assert.equal(props.size.required, false)
  assert.equal(props.title.required, true)
  assert.match(props.size.documentation, /Display size/)
  assert.equal(props.size.type, 'Size')
})

test('normal and type-only imports follow renamed named reexports and local export lists', async () => {
  for (const imported of ['import { PublicProps as Props }', 'import type { PublicProps as Props }', 'import { type PublicProps as Props }']) {
    const f = fixture(`<script setup lang="ts">${imported} from './barrel'; defineProps<Props>()</script>`, {
      '/app/barrel.ts': `export type { InternalProps as PublicProps } from './bridge'`,
      '/app/bridge.ts': `import { Original as InternalProps } from './types'; export { InternalProps }`,
      '/app/types.ts': `type Tone = 'calm' | 'bright'; interface Base { enabled?: boolean }
        export interface Original extends Base { tone: Tone }`
    })
    const props = byName(await f.info())
    assert.deepEqual(Object.keys(props).sort(), ['enabled', 'tone'])
    assert.deepEqual(values(props.tone), ['calm', 'bright'])
    assert.equal(props.tone.fileName, '/app/types.ts')
    assert.equal(props.tone.required, true)
  }
})

test('imported property aliases resolve in their own module with one module read per request', async () => {
  const f = fixture(`<script setup lang="ts">
    import { Choice as Mode } from './choices'
    interface Props { first: Mode; second?: Mode; mixed: Mode | 'auto' }
    defineProps<Props>()
  </script>`, {
    '/app/choices.ts': `export type { Mode as Choice } from './actual'`,
    '/app/actual.ts': `type Small = 'small'; export type Mode = Small | 'large'`
  })
  const props = byName(await f.info())
  assert.deepEqual(values(props.first), ['small', 'large'])
  assert.deepEqual(values(props.second), ['small', 'large'])
  assert.deepEqual(values(props.mixed), ['small', 'large', 'auto'])
  assert.equal(f.loads.filter(file => file === '/app/choices.ts').length, 1)
  assert.equal(f.loads.filter(file => file === '/app/actual.ts').length, 1)
})

test('default type declarations and namespace type imports retain explicit contracts', async () => {
  const f = fixture(`<script setup lang="ts">
    import DefaultProps from './defaults'
    import type * as Contracts from './types'
    defineProps<DefaultProps & Contracts.Extra>()
  </script>`, {
    '/app/defaults.ts': `export default interface Props { kind: 'main' }`,
    '/app/types.ts': `export type Extra = { side?: 'left' | 'right' }`
  })
  const props = byName(await f.info())
  assert.deepEqual(values(props.kind), ['main'])
  assert.deepEqual(values(props.side), ['left', 'right'])
})

test('interface own properties override bases and diamond inheritance preserves shared declarations', async () => {
  const f = fixture(`<script setup lang="ts">
    interface Root { shared?: 'shared'; tone?: string }
    interface Left extends Root { left: number }
    interface Right extends Root { right: number }
    interface Props extends Left, Right { tone: 'bright' }
    defineProps<Props>()
  </script>`)
  const props = byName(await f.info())
  assert.deepEqual(Object.keys(props).sort(), ['left', 'right', 'shared', 'tone'])
  assert.equal(props.shared.required, false)
  assert.equal(props.tone.required, true)
  assert.deepEqual(values(props.tone), ['bright'])
})

test('conflicting intersection or inherited properties do not invent required flags or values', async () => {
  for (const declaration of [
    `type Props = { mode: 'a'; safe: boolean } & { 'mode'?: 'b' }`,
    `type Left = { mode: 'a'; safe: boolean }; type Inner = Left & { mode: 'b' }; type Props = Inner & { mode: 'a' }`,
    `interface A { mode: 'a' }; interface B { 'mode'?: 'b' }; interface Props extends A, B { safe: boolean }`
  ]) {
    const f = fixture(`<script setup lang="ts">${declaration}; defineProps<Props>()</script>`)
    const props = byName(await f.info())
    assert.deepEqual(Object.keys(props), ['safe'])
    assert.equal(props.safe.required, true)
  }
})

test('unsupported generic, mapped and unresolved contracts return only known static members', async () => {
  for (const declaration of [
    `type Generic<T> = { value: T }; type Props = Generic<'x'>`,
    `type Props = Partial<{ value: 'x' }>`,
    `type Props = { [K in 'value']: 'x' }`,
    `type Props = Missing`,
    `type Props = { value: 'x' } & Missing`,
    `type Props = Props & { value: 'x' }`
  ]) {
    const f = fixture(`<script setup lang="ts">${declaration}; defineProps<Props>()</script>`)
    assert.deepEqual((await f.info()).props, [], declaration)
  }
  const f = fixture(`<script setup lang="ts">
    interface Props extends Missing { mode?: MissingLiteral; known: 'yes' }
    defineProps<Props>()
  </script>`)
  const props = byName(await f.info())
  assert.deepEqual(values(props.mode), [])
  assert.equal(props.mode.required, false)
  assert.deepEqual(values(props.known), ['yes'])
})

test('cyclic prop and literal aliases terminate without suggesting unresolved literals', async () => {
  const f = fixture(`<script setup lang="ts">
    import { Props } from './a'
    defineProps<Props>()
  </script>`, {
    '/app/a.ts': `import { Base } from './b'; type Loop = 'maybe' | Loop;
      export interface Props extends Base { cyclic?: Loop; known: 'ok' }`,
    '/app/b.ts': `export type { Props as Base } from './a'`
  })
  const props = byName(await f.info())
  assert.deepEqual(Object.keys(props).sort(), ['cyclic', 'known'])
  assert.deepEqual(values(props.cyclic), [])
  assert.deepEqual(values(props.known), ['ok'])
  assert.ok(f.loads.length <= 4)
})

test('ambiguous export stars are suppressed even through a second barrel', async () => {
  const f = fixture(`<script setup lang="ts">import { Props } from './outer'; defineProps<Props>()</script>`, {
    '/app/outer.ts': `export * from './ambiguous'; export * from './a'`,
    '/app/ambiguous.ts': `export * from './a'; export * from './b'`,
    '/app/a.ts': `export interface Props { mode: 'a' }`,
    '/app/b.ts': `export interface Props { mode: 'b' }`
  })
  assert.deepEqual((await f.info()).props, [])
})

test('multiple barrel paths to the same explicit declaration remain unambiguous', async () => {
  const f = fixture(`<script setup lang="ts">import { Props } from './outer'; defineProps<Props>()</script>`, {
    '/app/outer.ts': `export * from './left'; export * from './right'`,
    '/app/left.ts': `export type { Props } from './actual'`,
    '/app/right.ts': `export { Props } from './actual'`,
    '/app/actual.ts': `export interface Props { mode: 'same' }`
  })
  assert.deepEqual(values((await f.info()).props[0]), ['same'])
})

test('long reexport chains and wide alias sets respect traversal limits', async () => {
  const files = {}
  for (let step = 0; step < 100; step++) {
    files[`/app/step${step}.ts`] = `export type { Props } from './step${step + 1}'`
  }
  files['/app/step100.ts'] = `export interface Props { late: 'hidden' }`
  const deep = fixture(`<script setup lang="ts">import { Props } from './step0'; defineProps<Props>()</script>`, files)
  assert.deepEqual((await deep.info()).props, [])
  assert.ok(deep.loads.length < 25, `unbounded depth: ${deep.loads.length}`)

  const imports = []
  const members = []
  const wideFiles = {}
  for (let step = 0; step < 100; step++) {
    imports.push(`import { Value as V${step} } from './value${step}'`)
    members.push(`p${step}?: V${step}`)
    wideFiles[`/app/value${step}.ts`] = `export type Value = 'v${step}'`
  }
  const wide = fixture(`<script setup lang="ts">${imports.join(';')};
    defineProps<{ ${members.join(';')} }>()</script>`, wideFiles)
  const props = (await wide.info()).props
  assert.equal(props.length, 100)
  assert.ok(wide.loads.length < 65, `unbounded work: ${wide.loads.length}`)
  assert.deepEqual(values(props.at(-1)), [])
})

test('cancellation before and after module reads suppresses unfinished type contracts', async () => {
  for (const during of ['resolve', 'load']) {
    let cancelled = false
    const f = fixture(`<script setup lang="ts">import { Props } from './types'; defineProps<Props>()</script>`, {
      '/app/types.ts': `export interface Props { mode: 'late' }`
    })
    const info = await f.info({
      isCancelled: () => cancelled,
      async resolveModule(specifier, from) {
        const file = await f.context.resolveModule(specifier, from)
        if (during === 'resolve' && specifier === './types') {
          cancelled = true
        }
        return file
      },
      async loadIndex(file) {
        const index = await f.context.loadIndex(file)
        if (during === 'load' && file === '/app/types.ts') {
          cancelled = true
        }
        return index
      }
    })
    assert.deepEqual(info.props, [], during)
    assert.equal(f.loads.includes('/app/types.ts'), during === 'load')
  }
})

test('missing or failing type modules fail safely without evaluating project code', async () => {
  const f = fixture(`<script setup lang="ts">import { Props } from './types'; defineProps<Props>()</script>`, {
    '/app/types.ts': `throw new Error('never execute'); export interface Props { mode: 'static' }`
  })
  assert.deepEqual(values((await f.info()).props[0]), ['static'])
  for (const method of ['resolveModule', 'loadIndex']) {
    const info = await f.info({
      async [method](...args) {
        if (args[0] === './Child.vue' || args[0] === '/app/Child.vue') {
          return f.context[method](...args)
        }
        throw new Error('unavailable')
      }
    })
    assert.deepEqual(info.props, [])
  }
})

test('runtime props, imported PropType literals, mixins and static events remain available', async () => {
  const f = fixture(`<script lang="ts">
    import mixin from './mixin'
    import { Mode } from './types'
    export default { mixins: [mixin], props: {
      mode: { type: String as PropType<Mode>, required: true, default: 'edit' },
      count: Number,
      enabled: { type: [String, Boolean], validator: value => ['yes', false].includes(value) }
    }, emits: ['saved'], methods: { run() { this.$emit('closed') } } }
  </script><template><button @click="$emit('selected')" /></template>`, {
    '/app/types.ts': `export type Mode = 'edit' | 'view'`,
    '/app/mixin.js': `export default { props: { inherited: { type: Boolean, default: false } } }`
  })
  const info = await f.info()
  const props = byName(info)
  assert.deepEqual(values(props.mode), ['edit', 'view'])
  assert.equal(props.mode.required, true)
  assert.equal(props.mode.default, "'edit'")
  assert.equal(props.inherited.default, 'false')
  assert.equal(props.count.type, 'number')
  assert.equal(props.enabled.type, 'string | boolean')
  assert.deepEqual(values(props.enabled), ['yes', 'false'])
  assert.deepEqual(info.events.map(event => event.name).sort(), ['closed', 'saved', 'selected'])

  const index = buildIndex(`<script>export default { props: ['plain'] }</script>`, 'vue', '/app/Array.vue')
  assert.deepEqual((await describeComponent(index, componentOptions(index), {})).props,
    [{ name: 'plain', type: 'unknown', required: false, values: [] }])
})
