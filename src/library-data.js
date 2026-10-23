'use strict'

const fs = require('node:fs')
const path = require('node:path')

function json(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function createLibraryData(root) {
  let cached
  function installed(name) {
    for (let directory = root;; directory = path.dirname(directory)) {
      const file = path.join(directory, 'node_modules', name, 'package.json')
      const manifest = json(file)
      if (manifest) {
        return { directory: path.dirname(file), manifest }
      }
      if (directory === path.dirname(directory)) {
        return null
      }
    }
  }
  function readData(directory, manifest) {
    const data = manifest.vetur
    if (!data) {
      return []
    }
    const safe = relative => typeof relative === 'string' && !path.isAbsolute(relative) &&
      !relative.split(/[\\/]/).includes('..') ? json(path.join(directory, relative)) : null
    const tags = safe(data.tags)
    const attributes = safe(data.attributes) || {}
    return Object.entries(tags || {}).map(([name, info]) => ({
      name, documentation: info.description || '',
      props: (info.attributes || []).map(attribute => {
        const value = attributes[`${name}/${attribute}`] || {}
        return { name: attribute, type: value.type || 'unknown', required: Boolean(value.required),
          default: value.default, documentation: value.description || '',
          values: (value.options || []).map(option => ({ value: String(option), text: JSON.stringify(option), string: true })) }
      }), events: []
    }))
  }
  return {
    invalidate() {
      cached = undefined
    },
    components() {
      if (cached) {
        return cached
      }
      const manifest = json(path.join(root, 'package.json')) || {}
      const components = readData(root, manifest)
      const packages = new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.devDependencies || {})])
      const element = installed('element-ui')
      if (packages.has('element-ui') && element && /^2\./.test(element.manifest.version)) {
        components.push(...require('./element-ui-2').map(component => ({ ...component,
          source: `element-ui@${element.manifest.version}` })))
      }
      for (const name of packages) {
        const dependency = installed(name)
        if (dependency) {
          components.push(...readData(dependency.directory, dependency.manifest).map(component =>
            ({ ...component, source: `${name}@${dependency.manifest.version}` })))
          if (name === 'vue-router' && /^3\./.test(dependency.manifest.version)) {
            components.push({ name: 'router-link', source: `vue-router@${dependency.manifest.version}`,
              documentation: 'Vue Router 3 navigation link.', events: [], props: [
                { name: 'to', type: 'string | object', required: true, values: [], documentation: 'Target route location.' },
                { name: 'replace', type: 'boolean', required: false, default: 'false', values: [], documentation: 'Replace the current history entry.' },
                { name: 'append', type: 'boolean', required: false, default: 'false', values: [] },
                { name: 'tag', type: 'string', required: false, default: 'a', values: [] },
                { name: 'active-class', type: 'string', required: false, values: [] },
                { name: 'exact', type: 'boolean', required: false, default: 'false', values: [] }
              ] }, { name: 'router-view', source: `vue-router@${dependency.manifest.version}`, documentation: 'Route outlet.',
              events: [], props: [{ name: 'name', type: 'string', required: false, default: 'default', values: [] }] })
          }
        }
      }
      cached = [...new Map(components.map(component => [component.name, component])).values()]
      return cached
    }
  }
}

module.exports = { createLibraryData }
