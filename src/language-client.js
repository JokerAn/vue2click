'use strict'

const { Worker } = require('node:worker_threads')
const path = require('node:path')
const fs = require('node:fs')

function createLanguageClient(vscode, context) {
  const projects = new Map()
  let sequence = 0
  function stamp(file) {
    try {
      const stat = fs.statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  }
  function dispose(project) {
    project.worker.terminate()
    for (const pending of project.pending.values()) {
      pending.resolve(undefined)
      pending.dispose()
    }
    project.pending.clear()
  }
  function rootFor(document) {
    const workspace = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath
    for (let directory = path.dirname(document.fileName);;) {
      if (['tsconfig.json', 'jsconfig.json', 'package.json'].some(file => fs.existsSync(path.join(directory, file)))) {
        return directory
      }
      const parent = path.dirname(directory)
      if (directory === workspace || directory === parent) {
        return workspace || path.dirname(document.fileName)
      }
      directory = parent
    }
  }
  const bundledWorker = path.join(context.extensionPath || path.resolve(__dirname, '..'), 'dist/language-worker.cjs')
  return {
    async request(method, document, position, token, args) {
      if (document.uri.scheme !== 'file' || token?.isCancellationRequested) {
        return undefined
      }
      const root = rootFor(document)
      // A background diagnostic must not evict the project serving an
      // interactive hover, completion or refactoring request.
      if (method === 'diagnostics' && projects.size && !projects.has(root) &&
        vscode.window.activeTextEditor?.document !== document) {
        return undefined
      }
      let project = projects.get(root)
      if (!project) {
        const workerPath = fs.existsSync(bundledWorker) ? bundledWorker : path.join(__dirname, 'language-worker.js')
        const libDirectory = path.join(path.dirname(bundledWorker), 'typescript')
        project = {
          worker: new Worker(workerPath, { workerData: {
            root, firstFile: document.fileName,
            libDirectory: fs.existsSync(libDirectory) ? libDirectory : undefined
          } }),
          pending: new Map(),
          sent: new Map(),
          configs: new Map(['tsconfig.json', 'jsconfig.json', 'package.json', '.gitignore']
            .map(file => [path.join(root, file), stamp(path.join(root, file))]))
        }
        const current = project
        project.worker.on('message', response => {
          const pending = current.pending.get(response.id)
          if (pending) {
            current.pending.delete(response.id)
            pending.dispose()
            if (response.error) {
              pending.reject(new Error(response.error))
            } else {
              pending.resolve(response.result)
            }
          }
        })
        project.worker.on('error', error => {
          for (const pending of current.pending.values()) {
            pending.dispose()
            pending.reject(error)
          }
          current.pending.clear()
          projects.delete(root)
        })
        projects.set(root, project)
        while (projects.size > 1) {
          const oldest = projects.keys().next().value
          dispose(projects.get(oldest))
          projects.delete(oldest)
        }
      }
      projects.delete(root)
      projects.set(root, project)
      const sourceDocuments = (vscode.workspace.textDocuments || [document])
        .filter(source => source.uri.scheme === 'file' && /\.(vue|[cm]?[jt]sx?)$/.test(source.fileName))
      const snapshots = sourceDocuments.map(source => {
        const previous = project.sent.get(source.fileName)
        const entry = { fileName: source.fileName, version: source.version }
        if (previous?.document !== source || previous?.version !== source.version) {
          entry.text = source.getText()
        }
        project.sent.set(source.fileName, { document: source, version: source.version })
        return entry
      })
      for (const file of project.sent.keys()) {
        if (!sourceDocuments.some(source => source.fileName === file)) {
          project.sent.delete(file)
        }
      }
      if (!snapshots.some(source => source.fileName === document.fileName)) {
        snapshots.push({ fileName: document.fileName, version: document.version, text: document.getText() })
      }
      const version = document.version
      const result = await new Promise((resolve, reject) => {
        const id = ++sequence
        const cancel = token?.onCancellationRequested?.(() => {
          project.pending.delete(id)
          cancel?.dispose()
          resolve(undefined)
        })
        project.pending.set(id, { resolve, reject, dispose: () => cancel?.dispose() })
        project.worker.postMessage({
          id, method, documents: snapshots, fileName: document.fileName,
          offset: typeof position === 'number' ? position : document.offsetAt(position), args
        })
      })
      return document.version === version && !token?.isCancellationRequested &&
        sourceDocuments.every(source => snapshots.find(value => value.fileName === source.fileName)?.version === source.version)
        ? result : undefined
    },
    invalidate() {
      for (const project of projects.values()) {
        dispose(project)
      }
      projects.clear()
    },
    fileChanged(fileName, kind) {
      for (const [root, project] of projects) {
        if (fileName.startsWith(root + path.sep)) {
          const configChanged = /(?:^|\/)(?:(?:tsconfig|jsconfig|package)\.json|\.gitignore)$/.test(fileName)
          if (configChanged) {
            if (configChanged && project.configs.get(fileName) === stamp(fileName)) {
              continue
            }
            dispose(project)
            projects.delete(root)
          } else {
            project.worker.postMessage({ method: 'invalidate', fileName, kind })
          }
        }
      }
    },
    dispose() {
      for (const project of projects.values()) {
        dispose(project)
      }
      projects.clear()
    }
  }
}

module.exports = { createLanguageClient }
