'use strict'

const fs = require('node:fs')
const path = require('node:path')

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const description = value => typeof value.description === 'string' ? value.description :
  typeof value.documentation === 'string' ? value.documentation : ''

function createLibraryData(root) {
  root = path.resolve(root)
  let cached
  const manifestFile = path.join(root, 'package.json')
  let files = new Set([manifestFile])
  function json(file) {
    files.add(file)
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      return record(value) ? value : null
    } catch {
      return null
    }
  }
  function installed(name) {
    if (!/^(@[a-z\d~][a-z\d._~-]*\/)?[a-z\d~][a-z\d._~-]*$/i.test(name)) {
      return null
    }
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
    if (!record(data)) {
      return []
    }
    const safe = relative => typeof relative === 'string' && relative && !path.isAbsolute(relative) && !path.win32.isAbsolute(relative) &&
      !relative.split(/[\\/]/).includes('..') ? json(path.join(directory, relative)) : null
    const tags = safe(data.tags)
    const attributes = safe(data.attributes) || {}
    const components = []
    for (const [name, info] of Object.entries(tags || {})) {
      if (!name.trim() || !record(info)) {
        continue
      }
      const component = { name, documentation: description(info), props: [], events: [] }
      for (const attribute of new Set(Array.isArray(info.attributes) ? info.attributes : [])) {
        if (typeof attribute !== 'string' || !attribute.trim()) {
          continue
        }
        // Vetur supports global attribute keys before component-specific keys.
        const global = Object.hasOwn(attributes, attribute) ? attributes[attribute] : null
        const scoped = attributes[`${name}/${attribute}`]
        const value = record(global) ? global : record(scoped) ? scoped : {}
        if (value.type === 'event') {
          const eventName = attribute.replace(/^(?:@|v-on:)/, '')
          if (eventName) {
            component.events.push({ name: eventName, documentation: description(value) })
          }
          continue
        }
        component.props.push({ name: attribute, type: typeof value.type === 'string' && value.type ? value.type : 'unknown',
          required: value.required === true, default: value.default, documentation: description(value),
          values: (Array.isArray(value.options) ? value.options : []).filter(option =>
            option === null || ['string', 'number', 'boolean'].includes(typeof option)).map(option =>
            ({ value: String(option), text: JSON.stringify(option), string: typeof option === 'string' })) })
      }
      components.push(component)
    }
    return components
  }
  return {
    affected(file) {
      return typeof file === 'string' && files.has(path.resolve(file))
    },
    invalidate() {
      cached = undefined
    },
    components() {
      if (cached) {
        return cached
      }
      files = new Set([manifestFile])
      const manifest = json(manifestFile) || {}
      const packages = new Set([...Object.keys(record(manifest.dependencies) ? manifest.dependencies : {}),
        ...Object.keys(record(manifest.devDependencies) ? manifest.devDependencies : {})])
      const dependencies = new Map([...packages].map(name => [name, installed(name)]))
      const components = []
      const element = dependencies.get('element-ui')
      if (element && typeof element.manifest.version === 'string' && /^2\./.test(element.manifest.version)) {
        components.push(...require('./element-ui-2').map(component => ({ ...component,
          source: `element-ui@${element.manifest.version}` })))
      }
      for (const [name, dependency] of dependencies) {
        if (dependency) {
          if (name === 'vue-router' && typeof dependency.manifest.version === 'string' && /^3\./.test(dependency.manifest.version)) {
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
      for (const [name, dependency] of dependencies) {
        if (dependency) {
          const version = dependency.manifest.version
          const source = typeof version === 'string' && version ? `${name}@${version}` : name
          components.push(...readData(dependency.directory, dependency.manifest).map(component =>
            ({ ...component, source })))
        }
      }
      components.push(...readData(root, manifest))
      cached = [...new Map(components.map(component => [component.name, component])).values()]
      return cached
    }
  }
}

module.exports = { createLibraryData }
