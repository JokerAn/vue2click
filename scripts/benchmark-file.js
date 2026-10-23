'use strict'

// Read-only benchmark against one real Vue SFC and its actual component files.
// Usage: npm run benchmark:file -- /absolute/path/Component.vue [--json]
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { createHash } = require('node:crypto')
const loadStarted = performance.now()
const ts = require('typescript')
const { buildIndex, findDefinition } = require('../src/resolver')
const { completionContext } = require('../src/completion')
const { findComponentDefinition, componentProps } = require('../src/components')
const { createModuleResolver } = require('../src/module-paths')
const moduleLoadMs = performance.now() - loadStarted

const round = value => Math.round(value * 1000) / 1000
const hash = text => createHash('sha256').update(text).digest('hex')

function distribution(samples) {
  const sorted = samples.slice().sort((a, b) => a - b)
  return {
    calls: samples.length,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: round(sorted.at(-1))
  }
}

function projectRoot(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    if (path.dirname(dir) === dir) {
      return path.dirname(file)
    }
  }
}

async function main() {
  const argument = process.argv.slice(2).find(arg => !arg.startsWith('--'))
  if (!argument) {
    throw new Error('Provide a Vue file: npm run benchmark:file -- /absolute/path/Component.vue')
  }
  const file = path.resolve(argument)
  const text = fs.readFileSync(file, 'utf8')
  const readSnapshots = new Map([[file, hash(text)]])
  const io = { sourceReads: 0, configReads: 0, stats: 0, moduleCalls: 0 }
  const indexes = new Map()
  let index
  const first = performance.now()
  index = buildIndex(text, 'vue', file)
  const firstBuildMs = round(performance.now() - first)
  const builds = []
  for (let i = 0; i < 10; i++) {
    const start = performance.now()
    index = buildIndex(text, 'vue', file)
    builds.push(performance.now() - start)
  }
  indexes.set(file, index)

  const templateOffsets = []
  for (const expression of index.templates) {
    for (const match of text.slice(expression.start, expression.end).matchAll(/[$\p{ID_Start}][$\p{ID_Continue}]*/gu)) {
      const offset = expression.start + match.index
      const hit = findDefinition(index, offset)
      if (hit && !templateOffsets.some(entry => entry.offset === offset)) {
        templateOffsets.push({ offset, hit })
      }
    }
  }
  const scriptOffsets = []
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const offset = node.name.getStart(index.root)
      const hit = findDefinition(index, offset)
      if (hit) {
        scriptOffsets.push({ offset, hit })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(index.root)
  function measureOffsets(offsets, query, calls = 1000) {
    if (!offsets.length) {
      throw new Error('No supported references for a required benchmark category')
    }
    const samples = []
    for (let i = 0; i < calls; i++) {
      const entry = offsets[Math.floor((i % Math.min(offsets.length, calls)) * offsets.length / Math.min(offsets.length, calls))]
      const at = performance.now()
      query(entry)
      samples.push(performance.now() - at)
    }
    return { references: offsets.length, ...distribution(samples) }
  }
  const definitions = {}
  for (const [name, offsets] of [['template', templateOffsets], ['script', scriptOffsets]]) {
    definitions[name] = measureOffsets(offsets, entry => {
      const actual = findDefinition(index, entry.offset)
      if (actual?.start !== entry.hit.start || actual?.end !== entry.hit.end) {
        throw new Error('Definition changed between requests')
      }
    })
  }
  const completions = {}
  for (const [name, offsets] of [['template', templateOffsets], ['script', scriptOffsets]]) {
    const positions = offsets.filter(entry => completionContext(index, text, entry.offset).items.length)
    completions[name] = measureOffsets(positions, entry => {
      if (!completionContext(index, text, entry.offset).items.length) {
        throw new Error('Completion unexpectedly empty')
      }
    }, 500)
  }

  const root = projectRoot(file)
  function context() {
    const resolve = createModuleResolver({
      workspaceRoot: root,
      async readFile(target) {
        io.configReads++
        const source = await fs.promises.readFile(target, 'utf8')
        readSnapshots.set(target, hash(source))
        return source
      },
      async isFile(target) {
        io.stats++
        return (await fs.promises.stat(target)).isFile()
      }
    })
    return {
      isCancelled: () => false,
      resolveModule(specifier, from) { io.moduleCalls++; return resolve(specifier, from) },
      async loadIndex(target) {
        if (!indexes.has(target)) {
          const source = await fs.promises.readFile(target, 'utf8')
          io.sourceReads++
          readSnapshots.set(target, hash(source))
          indexes.set(target, buildIndex(source, target.endsWith('.vue') ? 'vue' : 'javascript', target))
        }
        return indexes.get(target)
      }
    }
  }
  const references = index.templateReferences.filter(ref => ref.kind === 'prop' || ref.kind === 'component')
  const supported = []
  const coldAt = performance.now()
  for (const reference of references) {
    const hit = await findComponentDefinition(index, reference.start, context())
    if (hit && hit.fileName !== file) {
      supported.push({ reference, hit })
    }
  }
  const coldScanMs = round(performance.now() - coldAt)
  if (!supported.length) {
    throw new Error('No cross-file components/props resolved in the provided file')
  }
  const samples = []
  for (let i = 0; i < 100; i++) {
    const entry = supported[Math.floor((i % Math.min(supported.length, 100)) * supported.length / Math.min(supported.length, 100))]
    const at = performance.now()
    const actual = await findComponentDefinition(index, entry.reference.start, context())
    samples.push(performance.now() - at)
    if (actual?.fileName !== entry.hit.fileName || actual?.start !== entry.hit.start) {
      throw new Error('Cross-file definition changed between requests')
    }
  }
  const propReferences = supported.filter(entry => entry.reference.kind === 'prop')
  if (!propReferences.length) {
    throw new Error('No cross-file prop definitions resolved')
  }
  const props = []
  for (let i = 0; i < 60; i++) {
    const entry = propReferences[i % propReferences.length]
    const at = performance.now()
    const names = await componentProps(index, entry.reference.tag, context())
    props.push(performance.now() - at)
    if (!names.length) {
      throw new Error('Known child props did not complete')
    }
  }
  for (const [target, expected] of readSnapshots) {
    if (hash(fs.readFileSync(target, 'utf8')) !== expected) {
      throw new Error('A source/config file changed during this benchmark: ' + target)
    }
  }
  const result = {
    file, node: process.version, bytes: Buffer.byteLength(text), characters: text.length,
    lines: text.split('\n').length, expressions: index.templates.length,
    registeredCrossFileTargets: new Set(supported.map(entry => entry.hit.fileName)).size,
    moduleLoadMs: round(moduleLoadMs), firstBuildMs, warmBuild: distribution(builds),
    definitions, completions,
    crossFile: { supportedReferences: supported.length, supportedProps: propReferences.length,
      coldScanMs, warmDefinitions: distribution(samples), propCompletion: distribution(props), io },
    unchangedFilesVerified: readSnapshots.size,
    notes: [
      'Node API measurements; editor/IPC/rendering latency is measured separately by test:vscode.',
      'First build excludes module load. Warm builds rebuild the full index; warm queries reuse it.',
      'Cross-file requests reuse source indexes but start fresh path/config sessions, matching versioned provider caching.',
      'Cold scan resolves every component/prop reference for coverage; its total is not one-request latency.',
      'Read-only: SHA-256 verified for every successfully read source/config file.'
    ]
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
