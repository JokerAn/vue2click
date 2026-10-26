'use strict'

const { Worker } = require('node:worker_threads')
const path = require('node:path')
const fs = require('node:fs')
const { findNearestConfig, ancestors, fileStamp: stamp } = require('./project-config')

function createLanguageClient(vscode, context, WorkerClass = Worker, { idleMs = 5 * 60 * 1000, onConfigFiles, onStart } = {}) {
  const projects = new Map()
  const reportedFailures = new Set()
  let sequence = 0
  // A crashed worker used to look like "completion silently stopped working".
  // Report once per project; the manual restart command clears the mark.
  function reportFailure(root, error) {
    if (reportedFailures.has(root)) {
      return
    }
    reportedFailures.add(root)
    const detail = error?.message || String(error)
    try {
      const choice = vscode.window?.showWarningMessage?.(`VueClick 语言服务已停止：${detail}`,
        '重启语言服务', '查看状态')
      Promise.resolve(choice).then(value => {
        if (value === '重启语言服务') {
          return vscode.commands?.executeCommand?.('vueClick.restartLanguageService')
        }
        if (value === '查看状态') {
          return vscode.commands?.executeCommand?.('vueClick.showProjectInfo')
        }
      }).catch(() => {})
    } catch (notificationError) {
      console.error('[Vue2Click] Language service failure notification failed:', notificationError)
    }
  }
  function notifyConfigFiles() {
    onConfigFiles?.([...new Set([...projects.values()].filter(project => !project.disposed)
      .flatMap(project => [...project.configs.keys()]))])
  }
  function dispose(project) {
    project.disposed = true
    clearTimeout(project.idleTimer)
    project.queue.length = 0
    project.active = null
    project.worker.terminate()
    for (const pending of project.pending.values()) {
      pending.resolve(undefined)
      pending.dispose()
    }
    project.pending.clear()
    notifyConfigFiles()
  }
  function idle(project) {
    clearTimeout(project.idleTimer)
    if (project.disposed || project.active !== null || project.queue.length) {
      return
    }
    project.idleTimer = setTimeout(() => {
      if (projects.get(project.root) === project && project.active === null && !project.queue.length) {
        dispose(project)
        projects.delete(project.root)
      }
    }, idleMs)
    project.idleTimer.unref?.()
  }
  function dispatch(project) {
    if (project.disposed || project.active !== null) {
      return
    }
    while (project.queue.length) {
      const request = project.queue.shift()
      const pending = project.pending.get(request.id)
      if (!pending) {
        continue
      }
      if (request.token?.isCancellationRequested || !request.isCurrent()) {
        project.pending.delete(request.id)
        pending.dispose()
        pending.resolve(undefined)
        continue
      }
      project.active = request.id
      try {
        project.worker.postMessage(request.message)
        for (const [file, entry] of request.sentToAdd) {
          project.sent.set(file, entry)
        }
        for (const file of request.sentToRemove) {
          project.sent.delete(file)
        }
        return
      } catch (error) {
        project.active = null
        project.pending.delete(request.id)
        pending.dispose()
        pending.reject(error)
      }
    }
    idle(project)
  }
  function rootFor(document) {
    const workspace = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath
    const config = findNearestConfig(document.fileName, workspace)
    if (config) return path.dirname(config)
    for (const directory of ancestors(path.dirname(document.fileName), workspace)) {
      if (fs.existsSync(path.join(directory, 'package.json'))) {
        return directory
      }
    }
    return workspace || path.dirname(document.fileName)
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
      if (project && [...project.configs].some(([file, version]) => stamp(file) !== version)) {
        dispose(project)
        projects.delete(root)
        project = undefined
      }
      if (!project) {
        const workerPath = fs.existsSync(bundledWorker) ? bundledWorker : path.join(__dirname, 'language-worker.js')
        const libDirectory = path.join(path.dirname(bundledWorker), 'typescript')
        project = {
          root,
          worker: new WorkerClass(workerPath, { workerData: {
            root, firstFile: document.fileName,
            libDirectory: fs.existsSync(libDirectory) ? libDirectory : undefined
          } }),
          pending: new Map(),
          queue: [],
          active: null,
          disposed: false,
          sent: new Map(),
          configs: new Map(['tsconfig.json', 'jsconfig.json', 'package.json', '.gitignore']
            .map(file => [path.join(root, file), stamp(path.join(root, file))]))
        }
        const current = project
        project.worker.on('message', response => {
          if (current.disposed) return
          if (response.configuration) {
            if (response.configuration.some(entry => stamp(entry.fileName) !== entry.stamp)) {
              dispose(current)
              if (projects.get(root) === current) projects.delete(root)
              return
            }
            for (const entry of response.configuration) current.configs.set(path.resolve(entry.fileName), entry.stamp)
            notifyConfigFiles()
          }
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
          if (current.active === response.id) {
            current.active = null
            dispatch(current)
          }
        })
        function failed(error) {
          if (current.disposed) {
            return
          }
          clearTimeout(current.idleTimer)
          for (const pending of current.pending.values()) {
            pending.reject(error)
          }
          dispose(current)
          if (projects.get(root) === current) {
            projects.delete(root)
          }
          reportFailure(root, error)
        }
        project.worker.on('error', failed)
        project.worker.on('exit', code => failed(new Error(`VueClick language worker exited (${code}).`)))
        projects.set(root, project)
        try {
          // Let the host attach the source-change feed only now that a worker
          // exists to consume it.
          onStart?.()
        } catch (error) {
          console.error('[Vue2Click] Language service start hook failed:', error)
        }
        notifyConfigFiles()
        while (projects.size > 1) {
          const oldest = projects.keys().next().value
          dispose(projects.get(oldest))
          projects.delete(oldest)
        }
      }
      projects.delete(root)
      projects.set(root, project)
      clearTimeout(project.idleTimer)
      const openDocuments = (vscode.workspace.textDocuments || [document])
        .filter(source => source.uri.scheme === 'file' && !source.isClosed &&
          source.fileName.startsWith(root + path.sep) && /\.(vue|[cm]?[jt]sx?)$/.test(source.fileName))
      const sourceDocuments = openDocuments.some(source => source.fileName === document.fileName)
        ? openDocuments : [...openDocuments, document]
      const versions = new Map(sourceDocuments.map(source => [source, source.version]))
      const snapshots = sourceDocuments.map(source => {
        const previous = project.sent.get(source.fileName)
        const entry = { fileName: source.fileName, version: source.version }
        if (previous?.document !== source || previous?.version !== source.version) {
          entry.text = source.getText()
        }
        return entry
      })
      const sentToAdd = sourceDocuments.map(source =>
        [source.fileName, { document: source, version: source.version }])
      const sentToRemove = [...project.sent.keys()].filter(file =>
        !sourceDocuments.some(source => source.fileName === file))
      const version = document.version
      const isCurrent = () => document.version === version &&
        [...versions].every(([source, sourceVersion]) => !source.isClosed && source.version === sourceVersion)
      const result = await new Promise((resolve, reject) => {
        const id = ++sequence
        let cancel
        const pending = { resolve, reject, dispose: () => cancel?.dispose() }
        const cancelRequest = () => {
          if (!project.pending.has(id)) {
            return
          }
          project.pending.delete(id)
          if (project.active !== id) {
            project.queue = project.queue.filter(request => request.id !== id)
          }
          pending.dispose()
          resolve(undefined)
        }
        project.pending.set(id, pending)
        project.queue.push({
          id, token, isCurrent, sentToAdd, sentToRemove,
          message: {
            id, method, documents: snapshots, fileName: document.fileName,
            offset: typeof position === 'number' ? position : document.offsetAt(position), args
          }
        })
        cancel = token?.onCancellationRequested?.(cancelRequest)
        if (!project.pending.has(id)) {
          cancel?.dispose()
        } else if (token?.isCancellationRequested) {
          cancelRequest()
        } else {
          dispatch(project)
        }
      })
      return isCurrent() && !token?.isCancellationRequested ? result : undefined
    },
    invalidate() {
      reportedFailures.clear()
      for (const project of projects.values()) {
        dispose(project)
      }
      projects.clear()
    },
    status(document) {
      const root = document?.uri.scheme === 'file' ? rootFor(document) : undefined
      const project = root ? projects.get(root) : projects.values().next().value
      return {
        root: root || project?.root,
        state: !project ? 'not-started' : project.active === null ? 'ready' : 'busy',
        pendingRequests: project?.pending.size || 0,
        queuedRequests: project?.queue.length || 0,
        idleReleaseMinutes: idleMs / 60000
      }
    },
    close(document) {
      for (const [root, project] of projects) {
        if (!document.fileName.startsWith(root + path.sep)) {
          continue
        }
        const open = (vscode.workspace.textDocuments || []).some(source => source !== document && !source.isClosed &&
          source.uri.scheme === 'file' && /\.(vue|[cm]?[jt]sx?)$/.test(source.fileName) &&
          source.fileName.startsWith(root + path.sep))
        if (!open) {
          dispose(project)
          projects.delete(root)
        }
      }
    },
    fileChanged(fileName, kind) {
      fileName = path.resolve(fileName)
      for (const [root, project] of projects) {
        if (project.configs.has(fileName) || fileName.startsWith(root + path.sep)) {
          const configChanged = project.configs.has(fileName)
          if (configChanged) {
            if (project.configs.get(fileName) === stamp(fileName)) {
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
    isConfigDependency(fileName) {
      return [...projects.values()].some(project => project.configs.has(path.resolve(fileName)))
    },
    configDocumentChanged(fileName) {
      for (const [root, project] of projects) {
        if (project.configs.has(path.resolve(fileName))) {
          dispose(project)
          projects.delete(root)
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
