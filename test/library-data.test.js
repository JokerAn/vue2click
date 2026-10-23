'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLibraryData } = require('../src/library-data')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-library-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (file, value) => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value))
    return target
  }
  return { root, write }
}

test('Vetur workspace data supports global attributes and type:event entries', t => {
  const { root, write } = fixture(t)
  write('package.json', { vetur: { tags: './tags.json', attributes: './attributes.json' } })
  write('tags.json', { 'foo-tag': { description: 'A foo tag', attributes: ['mode', 'saved', '@closed', 'v-on:change'] } })
  write('attributes.json', {
    mode: { type: 'string', description: 'Shared mode', required: true, default: '', options: ['edit'] },
    'foo-tag/mode': { type: 'number', description: 'Shadowed scoped mode' },
    saved: { type: 'event', documentation: 'Saved notification' },
    'foo-tag/@closed': { type: 'event', description: 'Closed notification' },
    'foo-tag/v-on:change': { type: 'event', description: 'Change notification' }
  })
  const [component] = createLibraryData(root).components()
  assert.equal(component.documentation, 'A foo tag')
  assert.deepEqual(component.props, [{
    name: 'mode', type: 'string', required: true, default: '', documentation: 'Shared mode',
    values: [{ value: 'edit', text: '"edit"', string: true }]
  }])
  assert.deepEqual(component.events, [
    { name: 'saved', documentation: 'Saved notification' },
    { name: 'closed', documentation: 'Closed notification' },
    { name: 'change', documentation: 'Change notification' }
  ])
})

test('metadata options preserve string versus primitive expression completion semantics', t => {
  const { root, write } = fixture(t)
  write('package.json', { vetur: { tags: 'tags.json', attributes: 'attributes.json' } })
  write('tags.json', { 'typed-input': { attributes: ['value'] } })
  write('attributes.json', {
    'typed-input/value': { type: 'string | boolean | number | null', default: false,
      options: ['false', false, true, 0, 3.5, null, {}, [], { value: 'unsupported' }] }
  })
  const [prop] = createLibraryData(root).components()[0].props
  assert.equal(prop.default, false)
  assert.deepEqual(prop.values, [
    { value: 'false', text: '"false"', string: true },
    { value: 'false', text: 'false', string: false },
    { value: 'true', text: 'true', string: false },
    { value: '0', text: '0', string: false },
    { value: '3.5', text: '3.5', string: false },
    { value: 'null', text: 'null', string: false }
  ])
})

test('workspace data overrides package metadata which overrides built-in fallbacks', t => {
  const { root, write } = fixture(t)
  write('package.json', { dependencies: { 'element-ui': '^2', 'vue-router': '^3' },
    vetur: { tags: 'tags.json', attributes: 'attributes.json' } })
  write('node_modules/element-ui/package.json', { version: '2.15.14', main: 'throw.js',
    vetur: { tags: 'tags.json', attributes: 'attributes.json' } })
  fs.writeFileSync(path.join(root, 'node_modules/element-ui/throw.js'), 'throw new Error("must not execute packages")')
  write('node_modules/element-ui/tags.json', {
    'el-button': { description: 'Package button', attributes: ['package-prop'] },
    'el-select': { description: 'Package select', attributes: ['package-mode'] }
  })
  write('node_modules/element-ui/attributes.json', {})
  write('node_modules/vue-router/package.json', { version: '3.6.5',
    vetur: { tags: 'tags.json', attributes: 'attributes.json' } })
  write('node_modules/vue-router/tags.json', { 'router-link': { description: 'Package navigation', attributes: ['custom-to'] } })
  write('node_modules/vue-router/attributes.json', {})
  write('tags.json', { 'el-button': { description: 'Workspace button', attributes: ['workspace-prop'] } })
  write('attributes.json', {})
  const components = createLibraryData(root).components()
  assert.equal(components.filter(component => component.name === 'el-button').length, 1)
  assert.equal(components.find(component => component.name === 'el-button').documentation, 'Workspace button')
  assert.equal(components.find(component => component.name === 'el-button').source, undefined)
  assert.equal(components.find(component => component.name === 'el-select').source, 'element-ui@2.15.14')
  assert.equal(components.find(component => component.name === 'el-select').documentation, 'Package select')
  assert.equal(components.find(component => component.name === 'router-link').documentation, 'Package navigation')
  assert.ok(components.some(component => component.name === 'el-input'))
  assert.ok(components.some(component => component.name === 'router-view'))
})

test('built-in metadata requires a declared matching installed major version', t => {
  const { root, write } = fixture(t)
  const manifest = write('package.json', { dependencies: { 'element-ui': '*', 'vue-router': '*' } })
  write('node_modules/element-ui/package.json', { version: '3.0.0' })
  write('node_modules/vue-router/package.json', { version: '4.0.0' })
  const data = createLibraryData(root)
  assert.deepEqual(data.components(), [])
  write('node_modules/element-ui/package.json', { version: '2.15.14' })
  write('node_modules/vue-router/package.json', { version: '3.6.5' })
  fs.writeFileSync(manifest, '{}')
  data.invalidate()
  assert.deepEqual(data.components(), [], 'undeclared installed packages must not enable fallback metadata')
})

test('malformed individual tags, attributes and options preserve healthy entries', t => {
  const { root, write } = fixture(t)
  write('package.json', { vetur: { tags: 'tags.json', attributes: 'attributes.json' } })
  write('tags.json', {
    'bad-null': null, 'bad-array': [], 'bad-string': 'invalid', '': {},
    'valid-empty': { description: 12, attributes: {} },
    'good-tag': { description: 'Healthy component', attributes: [null, {}, [], false, '', 'mode', 'mode', 'amount', 'enabled', 'missing', 'toString'] }
  })
  write('attributes.json', {
    mode: null,
    'good-tag/mode': { type: 'string', options: ['edit'], required: 'false' },
    'good-tag/amount': { type: [], options: 'bad options' },
    'good-tag/enabled': [],
    'good-tag/missing': false
  })
  const components = createLibraryData(root).components()
  assert.deepEqual(components.map(component => component.name), ['valid-empty', 'good-tag'])
  assert.equal(components[0].documentation, '')
  assert.deepEqual(components[0].props, [])
  const props = components[1].props
  assert.deepEqual(props.map(prop => prop.name), ['mode', 'amount', 'enabled', 'missing', 'toString'])
  assert.equal(props[0].required, false)
  assert.deepEqual(props[0].values, [{ value: 'edit', text: '"edit"', string: true }])
  assert.ok(props.slice(1).every(prop => prop.type === 'unknown' && prop.values.length === 0))
})

test('broken metadata in one package does not hide other package or workspace data', t => {
  const { root, write } = fixture(t)
  write('package.json', { dependencies: { broken: '*', invalid: '*', healthy: '*' },
    vetur: { tags: 'workspace-tags.json', attributes: 'workspace-attributes.json' } })
  write('node_modules/broken/package.json', { version: '1', vetur: { tags: 'tags.json', attributes: 'attributes.json' } })
  write('node_modules/broken/tags.json', ['wrong top-level shape'])
  write('node_modules/broken/attributes.json', null)
  write('node_modules/invalid/package.json', { version: '1', vetur: { tags: 'tags.json' } })
  fs.writeFileSync(path.join(root, 'node_modules/invalid/tags.json'), '{invalid json')
  write('node_modules/healthy/package.json', { version: '1.2.3', vetur: { tags: 'tags.json', attributes: 'attributes.json' } })
  write('node_modules/healthy/tags.json', { 'healthy-tag': { attributes: ['value'] } })
  write('node_modules/healthy/attributes.json', ['invalid attributes shape'])
  write('workspace-tags.json', { 'workspace-tag': { attributes: [] } })
  write('workspace-attributes.json', {})
  const components = createLibraryData(root).components()
  assert.deepEqual(components.map(component => component.name), ['healthy-tag', 'workspace-tag'])
  assert.equal(components[0].source, 'healthy@1.2.3')
  assert.equal(components[0].props[0].type, 'unknown')
})

test('malformed manifest containers are ignored safely', t => {
  const { root, write } = fixture(t)
  for (const manifest of [null, [], { dependencies: ['bad'], devDependencies: 'bad', vetur: [] },
    { dependencies: false, devDependencies: 42, vetur: { tags: null, attributes: {} } }]) {
    write('package.json', manifest)
    assert.deepEqual(createLibraryData(root).components(), [])
  }
})

test('malformed package versions cannot activate built-ins or poison package metadata', t => {
  const { root, write } = fixture(t)
  write('package.json', { dependencies: { 'element-ui': '*', 'vue-router': '*' } })
  const version = { toString: null, valueOf: null }
  write('node_modules/element-ui/package.json', { version, vetur: { tags: 'tags.json' } })
  write('node_modules/element-ui/tags.json', { 'custom-button': { attributes: [] } })
  write('node_modules/vue-router/package.json', { version })
  assert.deepEqual(createLibraryData(root).components(), [
    { name: 'custom-button', source: 'element-ui', documentation: '', props: [], events: [] }
  ])
})

test('scoped metadata packages resolve through hoisted node_modules without evaluation', t => {
  const { root, write } = fixture(t)
  write('apps/site/package.json', { devDependencies: { '@acme/ui': '^1' } })
  write('node_modules/@acme/ui/package.json', { version: '1.4.2', main: 'throw.js',
    vetur: { tags: 'meta/tags.json', attributes: 'meta/attributes.json' } })
  fs.writeFileSync(path.join(root, 'node_modules/@acme/ui/throw.js'), 'throw new Error("must not execute packages")')
  write('node_modules/@acme/ui/meta/tags.json', { 'acme-card': { attributes: ['title'] } })
  write('node_modules/@acme/ui/meta/attributes.json', { 'acme-card/title': { type: 'string', description: 'Card title' } })
  const data = createLibraryData(path.join(root, 'apps/site'))
  assert.equal(data.components()[0].source, '@acme/ui@1.4.2')
  assert.equal(data.components()[0].props[0].documentation, 'Card title')
  assert.equal(data.affected(path.join(root, 'node_modules/@acme/ui/meta/attributes.json')), true)
})

test('metadata cache avoids repeated reads and tracks arbitrary and missing metadata paths', t => {
  const { root, write } = fixture(t)
  const manifest = { dependencies: { absent: '*' },
    vetur: { tags: 'meta/components.data', attributes: 'meta/properties.data' } }
  const manifestFile = write('package.json', manifest)
  write('meta/components.data', { 'custom-child': { attributes: ['mode'] } })
  const attributesFile = write('meta/properties.data', { 'custom-child/mode': { options: ['edit'] } })
  const data = createLibraryData(root)
  assert.equal(data.affected(manifestFile), true)
  assert.equal(data.affected(attributesFile), false)
  const originalRead = fs.readFileSync
  let reads = 0
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    reads++
    return originalRead.call(this, file, ...args)
  })
  const first = data.components()
  const coldReads = reads
  assert.ok(coldReads > 0)
  assert.equal(data.components(), first)
  assert.equal(data.affected(attributesFile), true)
  assert.equal(data.affected(path.join(root, 'node_modules/absent/package.json')), true)
  assert.equal(data.affected(path.join(root, 'unrelated.json')), false)
  assert.equal(reads, coldReads)
  write('meta/properties.data', { 'custom-child/mode': { options: ['view'] } })
  assert.equal(data.components()[0].props[0].values[0].value, 'edit')
  data.invalidate()
  assert.equal(data.affected(attributesFile), true)
  assert.equal(data.components()[0].props[0].values[0].value, 'view')
  write('package.json', { ...manifest, vetur: { tags: 'new-tags.json', attributes: 'new-attributes.json' } })
  data.invalidate()
  assert.deepEqual(data.components(), [])
  assert.equal(data.affected(attributesFile), false)
  assert.equal(data.affected(path.join(root, 'new-tags.json')), true)
  assert.equal(data.affected(path.join(root, 'new-attributes.json')), true)
})

test('metadata references and package names cannot traverse outside their package', t => {
  const { root, write } = fixture(t)
  const metadataFile = write('outside-tags.json', { 'outside-tag': { attributes: [] } })
  write('package.json', { dependencies: { '../outside': '*', '@scope/../../outside': '*' },
    vetur: { tags: 'nested/../outside-tags.json', attributes: metadataFile } })
  const data = createLibraryData(root)
  assert.deepEqual(data.components(), [])
  assert.equal(data.affected(metadataFile), false)
  assert.equal(data.affected(path.join(root, 'outside/package.json')), false)
})
