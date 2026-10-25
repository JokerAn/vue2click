'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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
