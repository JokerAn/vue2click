'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { resolveModulePath, createModuleResolver } = require('../src/module-paths')

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vueclick-paths-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (name, contents = '') => {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents)
    return file
  }
  for (const [name, contents] of Object.entries(files)) await write(name, typeof contents === 'object' ? JSON.stringify(contents) : contents)
  const from = await write('src/views/Parent.vue')
  return { root, from, write, resolve: (specifier, options) => resolveModulePath(specifier, from, { workspaceRoot: root, ...options }) }
}

test('relative/absolute source files, extensionless imports and directory index resolve', async t => {
  const f = await fixture(t, {
    'src/components/Child.vue': '',
    'src/components/Folder/index.vue': '',
    'src/components/Runtime.js': '',
    'src/components/Runtime.ts': '',
    'src/components/Source.ts': '',
    'src/components/Other.tsx': '',
    'src/components/Esm.mjs': '',
    'src/components/Common.cjs': '',
    'src/components/Decl.d.ts': '',
    'src/components/style.css': ''
  })
  for (const [specifier, target] of [
    ['../components/Child.vue', 'Child.vue'],
    ['../components/Child', 'Child.vue'],
    ['../components/Folder', 'Folder/index.vue'],
    ['../components/Runtime', 'Runtime.js'],
    ['../components/Source.js', 'Source.ts'],
    ['../components/Other.jsx', 'Other.tsx'],
    ['../components/Esm', 'Esm.mjs'],
    ['../components/Common', 'Common.cjs']
  ]) assert.equal(await f.resolve(specifier), path.join(f.root, 'src/components', target), specifier)
  const absolute = path.join(f.root, 'src/components/Child.vue')
  assert.equal(await f.resolve(absolute), absolute)
  for (const specifier of ['../components/Missing', '../components/Decl.d.ts', '../components/style.css']) assert.equal(await f.resolve(specifier), null)
})

test('JSONC configuration resolves baseUrl and ordered paths; exact/more specific mapping wins', async t => {
  const f = await fixture(t, {
    'jsconfig.json': `{
      // A real jsconfig permits comments and trailing commas.
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["missing/*", "src/*"],
          "@/exact": ["alternative/Exact.vue"],
          "@/components/*": ["alternative/*"],
          "@/broken/*": ["missing/*"],
        },
      },
    }`,
    'src/plain.js': '',
    'src/components/Child.vue': '',
    'src/broken/Child.vue': '',
    'alternative/Child.vue': '',
    'alternative/Exact.vue': ''
  })
  assert.equal(await f.resolve('@/plain'), path.join(f.root, 'src/plain.js'))
  assert.equal(await f.resolve('src/plain'), path.join(f.root, 'src/plain.js'))
  assert.equal(await f.resolve('@/exact'), path.join(f.root, 'alternative/Exact.vue'))
  assert.equal(await f.resolve('@/components/Child'), path.join(f.root, 'alternative/Child.vue'))
  assert.equal(await f.resolve('@/broken/Child'), null, 'an explicit mapping must not be bypassed by fallback')
})

test('nearest config and workspace boundary are respected', async t => {
  const f = await fixture(t, {
    'tsconfig.json': { compilerOptions: { paths: { '@/*': ['outer/*'] } } },
    'outer/Child.vue': '',
    'src/views/jsconfig.json': { compilerOptions: { paths: { '@/*': ['local/*'] } } },
    'src/views/local/Child.vue': ''
  })
  assert.equal(await f.resolve('@/Child'), path.join(f.root, 'src/views/local/Child.vue'))
  assert.equal(await f.resolve('@/Missing'), null)
  await fs.unlink(path.join(f.root, 'src/views/jsconfig.json'))
  assert.equal(await f.resolve('@/Child'), path.join(f.root, 'outer/Child.vue'))
  assert.equal(await f.resolve('@/Child', { workspaceRoot: path.join(f.root, 'src') }), null)
})

test('src fallback supports @/ and ~/ and stops at the nearest src', async t => {
  const f = await fixture(t, { 'src/components/Child.vue': '', 'outside.vue': '' })
  for (const alias of ['@/', '~/']) assert.equal(await f.resolve(alias + 'components/Child'), path.join(f.root, 'src/components/Child.vue'))
  assert.equal(await f.resolve('@/../outside.vue'), null)
  await f.write('nested/src/views/Page.vue')
  assert.equal(await resolveModulePath('@/components/Child', path.join(f.root, 'nested/src/views/Page.vue'), { workspaceRoot: f.root }), null)
  await fs.rm(path.join(f.root, 'src'), { recursive: true })
  assert.equal(await resolveModulePath('@/components/Child', path.join(f.root, 'Page.vue'), { workspaceRoot: f.root }), null)
})

test('explicit alias definitions block fallback even if their key does not match the import', async t => {
  const f = await fixture(t, {
    'jsconfig.json': { compilerOptions: { paths: { '@': ['wrong'], '~/other/*': ['wrong/*'] } } },
    'src/components/Child.vue': ''
  })
  assert.equal(await f.resolve('@/components/Child'), null)
  assert.equal(await f.resolve('~/components/Child'), null)
})

test('extends resolves inherited paths relative to their declaring file, and baseUrl relative to its config', async t => {
  const f = await fixture(t, {
    'configs/base.json': { compilerOptions: { paths: { 'child/*': ['../src/components/*'] } } },
    'tsconfig.json': { extends: './configs/base' },
    'src/components/Child.vue': ''
  })
  assert.equal(await f.resolve('child/Child'), path.join(f.root, 'src/components/Child.vue'))
  await f.write('configs/base.json', JSON.stringify({ compilerOptions: { baseUrl: '../src', paths: { 'child/*': ['components/*'] } } }))
  assert.equal(await f.resolve('child/Child'), path.join(f.root, 'src/components/Child.vue'))
  await f.write('tsconfig.json', JSON.stringify({ extends: './configs/base', compilerOptions: { paths: { 'new/*': ['components/*'] } } }))
  assert.equal(await f.resolve('child/Child'), null, 'paths in child config replaces inherited paths')
  assert.equal(await f.resolve('new/Child'), path.join(f.root, 'src/components/Child.vue'))
})

test('package config extends and cyclic/missing extends remain safe', async t => {
  const f = await fixture(t, {
    'tsconfig.json': { extends: 'config-package/base', compilerOptions: { paths: { '@/*': ['src/*'] } } },
    'node_modules/config-package/package.json': { name: 'config-package' },
    'node_modules/config-package/base.json': { compilerOptions: { baseUrl: '../..' } },
    'src/components/Child.vue': ''
  })
  assert.equal(await f.resolve('@/components/Child'), path.join(f.root, 'src/components/Child.vue'))
  await f.write('tsconfig.json', JSON.stringify({ extends: './cycle.json', compilerOptions: { paths: { '@/*': ['src/*'] } } }))
  await f.write('cycle.json', JSON.stringify({ extends: './tsconfig.json' }))
  assert.equal(await f.resolve('@/components/Child'), path.join(f.root, 'src/components/Child.vue'))
  await f.write('cycle.json', JSON.stringify({ extends: './missing.json' }))
  assert.equal(await f.resolve('@/components/Child'), path.join(f.root, 'src/components/Child.vue'))
})

test('multiple config bases merge only fields actually supplied by each base', async t => {
  const f = await fixture(t, {
    'tsconfig.json': { extends: ['./paths.json', './other.json'] },
    'paths.json': { compilerOptions: { paths: { 'component/*': ['src/components/*'] } } },
    'other.json': { compilerOptions: { strict: true } },
    'src/components/Child.vue': ''
  })
  assert.equal(await f.resolve('component/Child'), path.join(f.root, 'src/components/Child.vue'))
})

test('configDir templates in inherited paths and baseUrl use the consuming configuration directory', async t => {
  const f = await fixture(t, {
    'configs/base.json': { compilerOptions: { paths: { 'component/*': ['${configDir}/src/components/*'] } } },
    'tsconfig.json': { extends: './configs/base' },
    'src/components/Child.vue': ''
  })
  const child = path.join(f.root, 'src/components/Child.vue')
  assert.equal(await f.resolve('component/Child'), child)
  await f.write('configs/base.json', JSON.stringify({ compilerOptions: {
    baseUrl: '${configDir}/src', paths: { 'component/*': ['components/*'] }
  } }))
  assert.equal(await f.resolve('component/Child'), child)
})

test('configDir substitution follows TypeScript prefix-only and single-substitution rules', async t => {
  const f = await fixture(t, {
    'jsconfig.json': { compilerOptions: { paths: {
      'literal/*': ['literal/${configDir}/*'], 'repeated/*': ['${configDir}/${configDir}/*']
    } } },
    'literal/${configDir}/Child.vue': '',
    '${configDir}/Child.vue': ''
  })
  assert.equal(await f.resolve('literal/Child'), path.join(f.root, 'literal/${configDir}/Child.vue'))
  assert.equal(await f.resolve('repeated/Child'), path.join(f.root, '${configDir}/Child.vue'))
})

test('a shared traversal budget bounds repeated extends branches and prevents partial alias fallback', { timeout: 15000 }, async t => {
  const files = {
    'tsconfig.json': { extends: './configs/c0.json', compilerOptions: { paths: { 'component/*': ['src/components/*'] } } },
    'src/components/Child.vue': ''
  }
  for (let i = 0; i < 12; i++) {
    files[`configs/c${i}.json`] = i === 11 ? {} : { extends: [`./c${i + 1}.json`, `./c${i + 1}.json`] }
  }
  const f = await fixture(t, files)
  assert.equal(await f.resolve('component/Child'), null, 'must not use the root config after an incomplete merge')
  assert.equal(await f.resolve('@/components/Child'), null, 'must not fall back to an existing src file after budget exhaustion')

  // The limit is per resolution. Ordinary, modestly shared graphs still resolve.
  await f.write('configs/c3.json', '{}')
  assert.equal(await f.resolve('component/Child'), path.join(f.root, 'src/components/Child.vue'))
})

test('invalid extends entries also consume the shared budget', async t => {
  const f = await fixture(t, {
    'tsconfig.json': { extends: Array(300).fill('https://example.test/config.json') },
    'src/components/Child.vue': ''
  })
  assert.equal(await f.resolve('@/components/Child'), null)
})

test('an unreadable nearest config does not reuse aliases from a more distant config', async t => {
  const f = await fixture(t, {
    'tsconfig.json': { compilerOptions: { paths: { 'component/*': ['src/components/*'] } } },
    'src/views/tsconfig.json': '{}',
    'src/components/Child.vue': ''
  })
  assert.equal(await f.resolve('component/Child', {
    readFile: async file => {
      if (file === path.join(f.root, 'src/views/tsconfig.json')) throw new Error('denied')
      return fs.readFile(file, 'utf8')
    }
  }), null)
})

test('packages select runtime implementation rather than types and support subpaths/exports', async t => {
  const f = await fixture(t, {
    'node_modules/old-component/package.json': { types: 'types.d.ts', module: 'src/Component.vue', main: 'index.js' },
    'node_modules/old-component/types.d.ts': '',
    'node_modules/old-component/src/Component.vue': '',
    'node_modules/old-component/index.js': 'throw new Error("project code must never execute")',
    'node_modules/old-component/Child/index.vue': '',
    'node_modules/@scope/component/package.json': { exports: { '.': { types: './types.d.ts', import: './src/Component.vue', require: './index.js' }, './child/*': './src/*.vue' } },
    'node_modules/@scope/component/types.d.ts': '',
    'node_modules/@scope/component/src/Component.vue': '',
    'node_modules/@scope/component/src/Child.vue': '',
    'node_modules/@scope/component/index.js': '',
    'node_modules/@scope/component/private.vue': '',
    'node_modules/types-only/package.json': { types: 'index.d.ts', main: 'index.d.ts' },
    'node_modules/types-only/index.d.ts': ''
  })
  for (const [specifier, target] of [
    ['old-component', 'old-component/src/Component.vue'],
    ['old-component/Child', 'old-component/Child/index.vue'],
    ['@scope/component', '@scope/component/src/Component.vue'],
    ['@scope/component/child/Child', '@scope/component/src/Child.vue']
  ]) assert.equal(await f.resolve(specifier), path.join(f.root, 'node_modules', target), specifier)
  assert.equal(await f.resolve('@scope/component/private.vue'), null, 'exports remains authoritative')
  assert.equal(await f.resolve('types-only'), null)
  assert.equal(await f.resolve('no-such-package'), null)
  assert.equal(await f.resolve('old-component', { workspaceRoot: path.join(f.root, 'src') }), path.join(f.root, 'node_modules/old-component/src/Component.vue'))
})

test('package exports handle defaults/arrays and block traversal or unknown conditions', async t => {
  const f = await fixture(t, {
    'outside.vue': '',
    'node_modules/array-package/package.json': { exports: ['./absent.vue', { types: './index.d.ts', default: './Component.vue' }] },
    'node_modules/array-package/Component.vue': '',
    'node_modules/unsafe-package/package.json': { exports: '../../outside.vue' },
    'node_modules/custom-package/package.json': { exports: { development: './Component.vue' } },
    'node_modules/custom-package/Component.vue': ''
  })
  assert.equal(await f.resolve('array-package'), path.join(f.root, 'node_modules/array-package/Component.vue'))
  assert.equal(await f.resolve('unsafe-package'), null)
  assert.equal(await f.resolve('custom-package'), null)
  assert.equal(await f.resolve('array-package/../../outside.vue'), null)
})

test('missing files, bad configs, rejected IO and invalid specifiers never throw', async t => {
  const f = await fixture(t, { 'jsconfig.json': '{broken', 'src/components/Child.vue': '' })
  assert.equal(await f.resolve('@/components/Child'), path.join(f.root, 'src/components/Child.vue'))
  for (const value of ['', null, 42, 'https://example.test/Child.vue', 'file:///a.vue', 'node:fs', 'raw-loader!./Child.vue', './Child.vue?raw', './Child.vue#x', './Ch\0ild.vue']) assert.equal(await f.resolve(value), null)
  assert.equal(await f.resolve('../components/Child.vue', { isFile: async () => { throw new Error('denied') } }), null)
  assert.equal(await f.resolve('alias/Child', { readFile: async () => { throw new Error('denied') } }), null)
  assert.equal(await resolveModulePath('./Child.vue', 'relative/Parent.vue'), null)
})

test('injected readFile/isFile are used for configs and source candidates', async t => {
  const f = await fixture(t, {})
  const files = new Map([
    [path.join(f.root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"virtual/*":["generated/*"]}}}'],
    [path.join(f.root, 'generated/Child.vue'), '<template />']
  ])
  assert.equal(await f.resolve('virtual/Child', {
    readFile: async file => { if (!files.has(file)) throw new Error('missing'); return files.get(file) },
    isFile: async file => files.has(file)
  }), path.join(f.root, 'generated/Child.vue'))
})

test('one resolver session shares config reads and stats across distinct concurrent module imports', async t => {
  const f = await fixture(t, {
    'jsconfig.json': { compilerOptions: { paths: { 'component/*': ['src/components/*'] } } },
    'src/components/First.vue': '',
    'src/components/Second.vue': ''
  })
  const reads = new Map()
  const stats = new Map()
  const resolver = createModuleResolver({
    workspaceRoot: f.root,
    readFile: file => {
      reads.set(file, (reads.get(file) || 0) + 1)
      return fs.readFile(file, 'utf8')
    },
    isFile: async file => {
      stats.set(file, (stats.get(file) || 0) + 1)
      return (await fs.stat(file)).isFile()
    }
  })
  const first = path.join(f.root, 'src/components/First.vue')
  const second = path.join(f.root, 'src/components/Second.vue')
  assert.deepEqual(await Promise.all([
    resolver('component/First', f.from), resolver('component/Second', f.from)
  ]), [first, second])
  assert.equal(reads.get(path.join(f.root, 'jsconfig.json')), 1)
  assert.equal(stats.get(path.join(f.root, 'jsconfig.json')), 1)
  assert.equal(stats.get(first), 1)
  assert.equal(stats.get(second), 1)
  assert.ok([...reads.values(), ...stats.values()].every(count => count === 1), 'including missing config/candidate IO, all requests are shared')
})

test('missing files and config edits refresh in new sessions and independent resolveModulePath calls', async t => {
  const f = await fixture(t, {
    'jsconfig.json': { compilerOptions: { paths: { 'component/*': ['original/*'] } } }
  })
  const old = createModuleResolver({ workspaceRoot: f.root })
  assert.equal(await old('component/Child', f.from), null)
  const original = await f.write('original/Child.vue')
  assert.equal(await old('component/Child', f.from), null, 'missing file result remains consistent during this request')
  assert.equal(await createModuleResolver({ workspaceRoot: f.root })('component/Child', f.from), original)
  assert.equal(await f.resolve('component/Child'), original)

  const originalSession = createModuleResolver({ workspaceRoot: f.root })
  assert.equal(await originalSession('component/Child', f.from), original)
  const changed = await f.write('changed/Child.vue')
  await f.write('jsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'component/*': ['changed/*'] } } }))
  assert.equal(await originalSession('component/Child', f.from), original, 'config read result is stable for this request')
  assert.equal(await createModuleResolver({ workspaceRoot: f.root })('component/Child', f.from), changed)
  assert.equal(await f.resolve('component/Child'), changed, 'standalone calls do not share a session')
})

test('session caches synchronous throws and rejected IO, while a new session retries', async t => {
  const f = await fixture(t, {
    'jsconfig.json': { compilerOptions: { paths: { 'component/*': ['src/components/*'] } } },
    'src/components/Child.vue': ''
  })
  const config = path.join(f.root, 'jsconfig.json')
  const child = path.join(f.root, 'src/components/Child.vue')
  let denyRead = true
  let denyStat = false
  let configReads = 0
  let childStats = 0
  const options = {
    workspaceRoot: f.root,
    readFile: file => {
      if (file === config) {
        configReads++
        if (denyRead) throw new Error('synchronous read failure')
      }
      return fs.readFile(file, 'utf8')
    },
    isFile: file => {
      if (file === child) {
        childStats++
        if (denyStat) return Promise.reject(new Error('stat rejected'))
      }
      return fs.stat(file).then(stat => stat.isFile())
    }
  }
  const readDenied = createModuleResolver(options)
  assert.equal(await readDenied('component/Child', f.from), null)
  denyRead = false
  assert.equal(await readDenied('component/Child', f.from), null)
  assert.equal(configReads, 1)
  assert.equal(await createModuleResolver(options)('component/Child', f.from), child)
  assert.equal(configReads, 2)

  denyStat = true
  const statDenied = createModuleResolver(options)
  assert.equal(await statDenied('component/Child', f.from), null)
  const previousStats = childStats
  denyStat = false
  assert.equal(await statDenied('component/Child', f.from), null)
  assert.equal(childStats, previousStats)
  assert.equal(await createModuleResolver(options)('component/Child', f.from), child)
  assert.equal(childStats, previousStats + 1)

  const syncDenied = createModuleResolver({ workspaceRoot: f.root, isFile() { throw new Error('synchronous stat failure') } })
  assert.equal(await syncDenied('../components/Child.vue', f.from), null)
})
