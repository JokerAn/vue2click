'use strict'

const esbuild = require('esbuild')
const fs = require('node:fs')
const path = require('node:path')

function findPackageManifest(file) {
  let directory
  try {
    directory = path.dirname(fs.realpathSync(file))
  } catch {
    directory = path.dirname(path.resolve(file))
  }
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json')
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (manifest.name && manifest.version) {
        return { directory, manifest }
      }
    }
    directory = path.dirname(directory)
  }
  return null
}

function bundledPackages(inputs, projectRoot) {
  const packages = new Map()
  const root = fs.realpathSync(projectRoot)
  for (const file of inputs) {
    const owner = findPackageManifest(file)
    if (!owner) throw new Error(`Cannot identify bundled input: ${file}`)
    if (owner.directory !== root) {
      packages.set(`${owner.manifest.name}@${owner.manifest.version}`, owner)
    }
  }
  return packages
}

async function main() {
  const common = {
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', minify: true,
    external: ['vscode'], mainFields: ['module', 'main'], metafile: true
  }
  const bundles = await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js' }),
    esbuild.build({ ...common, entryPoints: ['src/language-worker.js'], outfile: 'dist/language-worker.cjs' })
  ])
  const dependencies = bundledPackages(bundles.flatMap(bundle => Object.keys(bundle.metafile.inputs)), process.cwd())
  if (!dependencies.size) throw new Error('Bundled dependency notices must not be empty')
  const notices = ['Bundled dependency license notices. Generated from the exact build inputs.\n']
  for (const [name, { directory, manifest }] of [...dependencies].sort()) {
    notices.push(`\n=== ${name} (${manifest.license || 'see notice'}) ===\n`)
    const files = fs.readdirSync(directory).filter(file => /^(?:licen[cs]e|copying|notice|thirdpartynotice)/i.test(file) &&
      fs.statSync(path.join(directory, file)).isFile())
    for (const file of files) {
      notices.push(fs.readFileSync(path.join(directory, file), 'utf8'))
    }
    if (!files.length) {
      notices.push(JSON.stringify(manifest.repository || {}) + '\n')
    }
  }
  fs.writeFileSync('dist/ThirdPartyNotices.txt', notices.join('\n'))
  const source = path.dirname(require.resolve('typescript'))
  const target = path.resolve('dist/typescript')
  fs.mkdirSync(target, { recursive: true })
  for (const file of fs.readdirSync(source)) {
    if (/^lib.*\.d\.ts$/.test(file) || file === 'LICENSE.txt' || file === 'ThirdPartyNoticeText.txt') {
      fs.copyFileSync(path.join(source, file), path.join(target, file))
    }
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}

module.exports = { findPackageManifest, bundledPackages, main }
