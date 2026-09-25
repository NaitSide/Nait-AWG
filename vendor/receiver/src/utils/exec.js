'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5000;

async function runFile(command, args = [], options = {}) {
  const timeout = Number(options.timeoutMs || process.env.COMMAND_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const result = await execFileAsync(command, args, {
    timeout,
    windowsHide: true,
    maxBuffer: options.maxBuffer || 1024 * 1024
  });

  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

module.exports = {
  runFile
};

