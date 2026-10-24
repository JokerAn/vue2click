'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { createProjectService } = require('./project-service')
let project
let queue = Promise.resolve()
parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      if (message.method === 'invalidate') {
        project?.invalidate(message.fileName, message.kind)
        return
      }
      project ||= createProjectService(workerData.root, workerData.firstFile, workerData.libDirectory)
      project.sync(message.documents)
      const result = await project.run(message.method, message.fileName, message.offset, message.args)
      parentPort.postMessage({ id: message.id, result, configuration: project.configuration() })
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: error.stack || String(error) })
    }
  })
})
