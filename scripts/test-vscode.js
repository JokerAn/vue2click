'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runTests } = require('@vscode/test-electron')

async function main() {
  const root = path.resolve(__dirname, '..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vueclick-vscode-'))
  try {
    await runTests({
      // Set VSCODE_TEST_VERSION=1.90.2 to check the declared minimum version.
      version: process.env.VSCODE_TEST_VERSION || 'stable',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'test/vscode/suite.js'),
      extensionTestsEnv: {
        VUECLICK_TEST_WORKSPACE: directory,
        VUECLICK_TEST_FILE: process.env.VUECLICK_TEST_FILE || ''
      },
      launchArgs: [
        directory,
        '--disable-extensions',
        '--skip-welcome',
        '--skip-release-notes',
        '--user-data-dir=' + path.join(directory, 'profile'),
        '--extensions-dir=' + path.join(directory, 'extensions')
      ]
    })
  } finally {
    if (process.env.VUECLICK_KEEP_TEST_WORKSPACE) {
      console.log('Preserved isolated test workspace: ' + directory)
    } else {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
