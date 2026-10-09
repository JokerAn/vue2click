#!/usr/bin/env node
'use strict'

// Run: node scripts/benchmark.js [--json]
// Optional: BENCH_PROJECT_ROOT, BENCH_BUILD_RUNS (5-10), BENCH_WARM_CALLS
// (200-1000), BENCH_CROSS_CALLS (1-500), BENCH_EXPRESSIONS (2000-5000).
// This measures the public resolver APIs, not VS Code's document/provider cache.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { buildIndex, findDefinition } = require('../src/resolver')
const { findComponentDefinition } = require('../src/components')
const { resolveModulePath, createModuleResolver } = require('../src/module-paths')

const config = {
  buildRuns: setting('BENCH_BUILD_RUNS', 7, 5, 10),
  warmCalls: setting('BENCH_WARM_CALLS', 800, 200, 1000),
  crossCalls: setting('BENCH_CROSS_CALLS', 60, 1, 500),
  expressions: setting('BENCH_EXPRESSIONS', 3000, 2000, 5000),
  batchBudgetMs: 25000
}

function setting(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

const round = value => Math.round(value * 10000) / 10000
const language = file => /\.vue$/i.test(file) ? 'vue' : /\.(ts|tsx)$/i.test(file) ? 'typescript' : 'javascript'

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    samples: samples.map(round),
    medianMs: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1])
  }
}

// Inspect only data properties or an explicit non-eager peek API. Reading an
// `index` getter here would parse every expression and invalidate the benchmark.
function parsedExpressions(index) {
  let known = true
  let parsed = 0
  for (const expression of index.templates) {
    const descriptor = Object.getOwnPropertyDescriptor(expression, 'index')
    if (descriptor && Object.hasOwn(descriptor, 'value')) parsed += Boolean(descriptor.value)
    else if (typeof expression.peek === 'function') parsed += Boolean(expression.peek())
    else known = false
  }
  return known ? parsed : null
}

function localOffsets(fixture, index) {
  const candidates = []
  for (const expression of index.templates) {
    // Search original template ranges without accessing lazy source/index getters.
    const raw = fixture.text.slice(expression.start, expression.end)
    for (const match of raw.matchAll(/\b(?:gotoPage|addressParams|currentReturnWays|changeResult|bookTimeData|isFoodSafeInsurance)\b/g)) {
      candidates.push({ offset: expression.start + match.index + 1, name: match[0],
        advertisementClick: /^gotoPage\s*\(\s*1\s*\)/.test(raw.slice(match.index)),
        addressParamValue: /:address-params\s*=\s*["']\s*$/.test(fixture.text.slice(Math.max(0, expression.start - 40), expression.start)) })
    }
  }
  if (!candidates.length) throw new Error(`No local references in ${fixture.fileName}`)
  return candidates
}

function warmLocal(index, offsets) {
  const valid = offsets.filter(candidate => findDefinition(index, candidate.offset))
  if (!valid.length) throw new Error('No validated local definition offsets')
  const started = performance.now()
  let hits = 0
  let completed = 0
  for (; completed < config.warmCalls; completed++) {
    const candidate = valid[completed % valid.length]
    if (findDefinition(index, candidate.offset)) hits++
    if (performance.now() - started >= config.batchBudgetMs) { completed++; break }
  }
  const totalMs = performance.now() - started
  return { calls: completed, hits, references: valid.length, firstReference: valid[0].name, firstOffset: valid[0].offset,
    totalMs: round(totalMs), perLookupMs: round(totalMs / completed),
    stoppedAtBudget: completed < config.warmCalls }
}

function benchmarkLocal(fixture) {
  // One untimed build warms the parser, excluding require/TypeScript startup.
  buildIndex(fixture.text, 'vue', fixture.fileName)
  const samples = []
  let index
  const started = performance.now()
  for (let run = 0; run < config.buildRuns; run++) {
    const at = performance.now()
    index = buildIndex(fixture.text, 'vue', fixture.fileName)
    samples.push(performance.now() - at)
    if (performance.now() - started >= config.batchBudgetMs) break
  }
  const parsedAfterBuild = parsedExpressions(index)
  const offsets = localOffsets(fixture, index)
  // Validate only offsets that will be queried; leave unrelated ASTs lazy.
  const goto = offsets.filter(candidate => candidate.name === 'gotoPage')
  const preferredGoto = goto.find(candidate => candidate.advertisementClick) || goto[0]
  const locals = offsets.filter(candidate => candidate.name !== 'gotoPage')
  const preferredLocal = locals.find(candidate => candidate.addressParamValue) || locals.find(candidate => candidate.name === 'addressParams') || locals[0]
  const distributed = Array.from({ length: Math.min(offsets.length, config.warmCalls) }, (_, i) =>
    offsets[Math.floor(i * offsets.length / Math.min(offsets.length, config.warmCalls))])
  const result = {
    name: fixture.name, fileName: fixture.fileName, bytes: Buffer.byteLength(fixture.text),
    expressionCount: index.templates.length,
    parsedExpressionsAfterBuild: parsedAfterBuild,
    build: { ...distribution(samples), runs: samples.length, stoppedAtBudget: samples.length < config.buildRuns },
    gotoPage: preferredGoto ? warmLocal(index, [preferredGoto]) : null,
    local: preferredLocal ? warmLocal(index, [preferredLocal]) : null,
    distributedExpressions: warmLocal(index, distributed),
    parsedExpressionsAfterWarm: parsedExpressions(index)
  }
  return result
}

function ioCounter() {
  const reads = new Map()
  const stats = new Map()
  const add = (map, file) => map.set(file, (map.get(file) || 0) + 1)
  const totals = map => ({ calls: [...map.values()].reduce((sum, count) => sum + count, 0), uniqueFiles: map.size,
    repeatedCalls: [...map.values()].reduce((sum, count) => sum + count - 1, 0),
    files: [...map].map(([fileName, calls]) => ({ fileName, calls })) })
  return {
    async readFile(file) { add(reads, file); return fs.readFile(file, 'utf8') },
    async isFile(file) { add(stats, file); return (await fs.stat(file)).isFile() },
    summary: () => ({ readFile: totals(reads), isFile: totals(stats) })
  }
}

async function benchmarkCross(fixture, workspaceRoot, reuseRequestIO = false) {
  const index = buildIndex(fixture.text, 'vue', fixture.fileName)
  const references = index.templateReferences.filter(reference => reference.tag === 'AddressTab' && reference.kind === 'prop')
  if (!references.length) return null
  const indexCache = new Map([[fixture.fileName, index]])
  const counts = ioCounter()
  let sourceReads = 0
  let moduleCalls = 0
  const resolverOptions = { workspaceRoot, readFile: counts.readFile, isFile: counts.isFile }
  let requestResolver
  const context = {
    isCancelled: () => false,
    resolveModule(specifier, fromFile) {
      moduleCalls++
      return requestResolver(specifier, fromFile)
    },
    async loadIndex(fileName) {
      if (!indexCache.has(fileName)) {
        sourceReads++
        indexCache.set(fileName, buildIndex(await fs.readFile(fileName, 'utf8'), language(fileName), fileName))
      }
      return indexCache.get(fileName)
    }
  }
  function lookup(reference) {
    // Start a new session for every definition request. This deliberately
    // refreshes file/config IO across requests, matching the provider contract.
    requestResolver = reuseRequestIO ? createModuleResolver(resolverOptions)
      : (specifier, fromFile) => resolveModulePath(specifier, fromFile, resolverOptions)
    return findComponentDefinition(index, reference.start + 1, context)
  }
  // Cache child indexes before timing; every measured prop navigation still
  // performs its own module-path lookup, as in the original provider strategy.
  const supported = []
  for (const reference of references) {
    if (await lookup(reference)) supported.push(reference)
  }
  if (!supported.length) throw new Error(`No resolvable AddressTab props in ${fixture.fileName}`)
  const warmupIO = counts.summary()
  const warmupSourceReads = sourceReads
  const warmupModuleCalls = moduleCalls
  const durations = []
  const started = performance.now()
  for (let call = 0; call < config.crossCalls; call++) {
    const reference = supported[call % supported.length]
    const at = performance.now()
    const hit = await lookup(reference)
    if (!hit) throw new Error(`Cross-file lookup failed for ${reference.name}`)
    durations.push(performance.now() - at)
    if (performance.now() - started >= config.batchBudgetMs) break
  }
  const totalMs = performance.now() - started
  const measuredIO = counts.summary()
  for (const operation of ['readFile', 'isFile']) {
    const previous = new Map(warmupIO[operation].files.map(file => [file.fileName, file.calls]))
    const files = measuredIO[operation].files.map(file => ({ ...file, calls: file.calls - (previous.get(file.fileName) || 0) }))
      .filter(file => file.calls > 0)
    measuredIO[operation] = {
      calls: files.reduce((sum, file) => sum + file.calls, 0), uniqueFiles: files.length,
      repeatedCalls: files.reduce((sum, file) => sum + file.calls - 1, 0), files
    }
  }
  return { name: fixture.name + (reuseRequestIO ? '-request-session' : ''), calls: durations.length, props: supported.map(reference => reference.name),
    totalMs: round(totalMs), perLookupMs: round(totalMs / durations.length),
    latency: distribution(durations), stoppedAtBudget: durations.length < config.crossCalls,
    moduleCalls: moduleCalls - warmupModuleCalls, sourceReads: sourceReads - warmupSourceReads,
    io: measuredIO, strategy: reuseRequestIO
      ? 'IO shared within each definition request; fresh session across requests; child indexes cached; excludes extension concurrency merging'
      : 'independent resolveModulePath calls; child indexes cached; excludes extension request/cache behavior' }
}

function synthetic(fileName) {
  const repeated = Array.from({ length: config.expressions }, (_, i) => i % 2
    ? '<button @click="gotoPage(1)">广告</button>'
    : '<div :title="addressParams">地址</div>').join('\n')
  return { name: 'synthetic-repeated-expressions', fileName,
    text: `<template>${repeated}</template><script>export default { data() { return { addressParams: {} } }, methods: { gotoPage(type) {} } }</script>` }
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vue2click-benchmark-'))
  try {
    const projectRoot = process.env.BENCH_PROJECT_ROOT || '/Users/anshunli1/jd/jdGit/product/web/apply-claim'
    const fixtures = []
    for (const name of ['process', 'apply']) {
      const fileName = path.join(projectRoot, 'src/views', name, 'index.vue')
      try { fixtures.push({ name: `real-${name}`, fileName, text: await fs.readFile(fileName, 'utf8') }) }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
    }
    const big = synthetic(path.join(temp, 'Repeated.vue'))
    fixtures.push(big)
    await fs.mkdir(path.join(temp, 'src/components'), { recursive: true })
    await fs.writeFile(path.join(temp, 'jsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@components/*': ['src/components/*'] } } }))
    await fs.writeFile(path.join(temp, 'src/components/barrel.js'), "export { default as AddressTab } from '@components/AddressTab.vue'")
    await fs.writeFile(path.join(temp, 'src/components/AddressTab.vue'), '<script>export default { props: { result: Object, addressParams: Object, bookTimeData: Object, urlQuery: Object } }</script>')
    const aliasFixture = { name: 'synthetic-alias-barrel', fileName: path.join(temp, 'src/Parent.vue'),
      text: `<template><AddressTab :result="{}" :address-params="{}" :bookTimeData="{}" :url-query="{}" /></template><script>import { AddressTab } from '@components/barrel'; export default { components: { AddressTab } }</script>` }
    const results = { node: process.version, timestamp: new Date().toISOString(), config,
      notes: ['Build timings exclude module startup and include a fresh full index.',
        'p95 is nearest-rank; 5-10 samples are descriptive, not a statistical regression threshold.',
        'Warm lookups use an existing index and validated expression positions.',
        'Cross-file IO counters measure attempted fs readFile/stat including missing config probes.',
        'Cross-file scenarios compare independent module calls with fresh per-request IO sessions; VS Code concurrency merging is not measured.'],
      local: fixtures.map(benchmarkLocal), crossFile: [] }
    for (const fixture of fixtures.filter(fixture => fixture.name === 'real-apply')) {
      results.crossFile.push(await benchmarkCross(fixture, projectRoot))
    }
    results.crossFile.push(await benchmarkCross(aliasFixture, temp))
    if (typeof createModuleResolver === 'function') {
      results.crossFile.push(await benchmarkCross(aliasFixture, temp, true))
    }
    if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2))
    else {
      console.log(`Node ${results.node}; builds=${config.buildRuns}; warm calls=${config.warmCalls}; cross calls=${config.crossCalls}`)
      for (const local of results.local) {
        console.log(`${local.name}: ${local.bytes} bytes, ${local.expressionCount} expressions; build median=${local.build.medianMs}ms p95=${local.build.p95Ms}ms; parsed=${local.parsedExpressionsAfterBuild ?? 'unknown'}`)
        for (const key of ['gotoPage', 'local', 'distributedExpressions']) {
          const sample = local[key]
          if (sample) console.log(`  ${key}: ${sample.calls} lookups, ${sample.totalMs}ms total, ${sample.perLookupMs}ms/lookup`)
        }
      }
      for (const cross of results.crossFile.filter(Boolean)) {
        console.log(`${cross.name} cross props: ${cross.calls} calls, ${cross.totalMs}ms total, ${cross.perLookupMs}ms/lookup; resolver readFile=${cross.io.readFile.calls}, stat=${cross.io.isFile.calls}, cached-source reads=${cross.sourceReads}`)
      }
      console.log('Use --json for per-path IO counts and complete timing samples. Extension caching is outside this benchmark.')
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
