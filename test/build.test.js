'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { brotliDecompressSync } = require('node:zlib')
const { findPackageManifest, bundledPackages } = require('../scripts/build')

test('build dependency lookup follows symlinked absolute bundle inputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-build-'))
  const packageRoot = path.join(root, 'dependency')
  const linked = path.join(root, 'node_modules', 'example-package')
  fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true })
  fs.mkdirSync(path.dirname(linked), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'example-package', version: '1.0.0' }))
  fs.writeFileSync(path.join(packageRoot, 'lib', 'index.js'), '')
  fs.symlinkSync(packageRoot, linked, 'dir')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const result = findPackageManifest(path.join(linked, 'lib', 'index.js'))
  assert.equal(result?.manifest.name, 'example-package')
  assert.equal(result?.manifest.version, '1.0.0')
})

test('bundle notices include real external inputs outside node_modules and exclude project sources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-notices-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of ['project', 'external']) {
    fs.mkdirSync(path.join(root, name, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'lib/index.js'), '')
    fs.writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT' }))
  }
  const project = path.join(root, 'project')
  const external = path.join(root, 'external/lib/index.js')
  const packages = bundledPackages([path.join(project, 'lib/index.js'), external, external], project)
  assert.deepEqual([...packages.keys()], ['external@1.0.0'])
})

test('production bundles share TypeScript and run without development dependencies', t => {
  const project = path.resolve(__dirname, '..')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-package-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.cpSync(path.join(project, 'src'), path.join(root, 'src'), { recursive: true })
  fs.cpSync(path.join(project, 'snippets'), path.join(root, 'snippets'), { recursive: true })
  fs.copyFileSync(path.join(project, 'package.json'), path.join(root, 'package.json'))
  fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  fs.mkdirSync(path.join(root, 'dist/typescript'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist/stale.cjs'), 'stale build output')
  fs.writeFileSync(path.join(root, 'dist/typescript/lib.removed.d.ts'), 'stale library')

  function run(script) {
    // The bundle build compiles TypeScript and compresses declarations; under a
    // parallel test run it can take well over half a minute on a busy machine.
    const result = spawnSync(process.execPath, [script], {
      cwd: root, encoding: 'utf8', timeout: 120000
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  run(path.join(project, 'scripts/build.js'))

  const dist = path.join(root, 'dist')
  assert.ok(fs.statSync(path.join(dist, 'extension.js')).size < 3_000_000,
    'the extension must not contain another copy of the TypeScript runtime')
  assert.ok(fs.statSync(path.join(dist, 'language-worker.cjs')).size < 2_000_000,
    'the worker must not contain another copy of the TypeScript runtime')
  assert.ok(fs.statSync(path.join(dist, 'typescript.cjs')).size < 4_000_000)
  for (const entry of ['extension.js', 'language-worker.cjs']) {
    const code = fs.readFileSync(path.join(dist, entry), 'utf8')
    assert.match(code, /require\(["']\.\/typescript\.cjs["']\)/)
  }
  assert.equal(fs.existsSync(path.join(dist, 'stale.cjs')), false)
  assert.equal(fs.existsSync(path.join(dist, 'typescript/lib.removed.d.ts')), false)
  const notices = fs.readFileSync(path.join(dist, 'ThirdPartyNotices.txt'), 'utf8')
  const version = require('typescript/package.json').version
  assert.equal(notices.split(`=== typescript@${version} (`).length - 1, 1,
    'the shared runtime must remain in the dependency license notices')
  const librarySource = path.dirname(require.resolve('typescript'))
  const libraries = fs.readdirSync(librarySource).filter(file => /^lib.*\.d\.ts$/.test(file))
  let compressedBytes = 0
  for (const file of libraries) {
    const packed = path.join(dist, 'typescript', file + '.br')
    assert.ok(fs.existsSync(packed), 'the standard library must ship compressed: ' + file)
    assert.equal(fs.existsSync(path.join(dist, 'typescript', file)), false,
      'the uncompressed standard library must not remain in the package')
    const bytes = fs.readFileSync(packed)
    compressedBytes += bytes.length
    assert.deepEqual(brotliDecompressSync(bytes), fs.readFileSync(path.join(librarySource, file)),
      'the standard library must decompress without any content changes: ' + file)
  }
  assert.ok(compressedBytes < 500_000, 'compressed standard libraries must stay below 500 KB')

  fs.unlinkSync(path.join(root, 'node_modules'))
  fs.mkdirSync(path.join(root, 'scripts'))
  const entryCheck = path.join(root, 'scripts/check-bundle.js')
  fs.copyFileSync(path.join(project, 'scripts/check-bundle.js'), entryCheck)
  run(entryCheck)
  run(path.join(project, 'scripts/check-worker.js'))
})
