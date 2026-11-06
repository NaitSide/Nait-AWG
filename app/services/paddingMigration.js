'use strict';
// Narrow, idempotent upgrade of the padding default shipped by the full installer.
async function migratePadding(service, {managed, preserve = false}) {
  if (!managed || preserve) return {status:'skipped'};
  const current = await service.getObfuscation();
  if (current.parameters.ContentPaddingAddition !== '10-100') return {status:'unchanged'};
  const result = await service.setObfuscation({confirmed:true, expectedRevision:current.revision,
    parameters:{...current.parameters, ContentPaddingAddition:'0'}});
  return {status:'applied', updatedConfigs:result.updatedConfigs || 0};
}
async function installedMigration(directory) {
  const fs = require('node:fs'), path = require('node:path');
  const {promisify} = require('node:util'), {execFile} = require('node:child_process');
  const {createRequire} = require('node:module');
  const root = path.resolve(directory), localRequire = createRequire(path.join(root, 'package.json'));
  const savedEnv = localRequire('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
  const env = {...savedEnv, ...process.env};
  if (savedEnv.NAIT_AWG_PRESERVE_PADDING === '1' || process.env.NAIT_AWG_PRESERVE_PADDING === '1') return {status:'skipped'};
  const container = env.AWG_CONTAINER_NAME || 'amnezia-awg';
  const {stdout} = await promisify(execFile)('docker', ['inspect','--format',
    '{{index .Config.Labels "org.nait-awg.managed"}}',container], {timeout:15000,maxBuffer:65536,windowsHide:true});
  if (stdout.trim() !== 'fresh-v1') return {status:'skipped'};
  process.chdir(root);
  // Reuse the panel's encrypted journal, revision checks, backup and profile rewrites.
  // The installer stops the web service so there is one application writer.
  const {createAwgService} = localRequire('./app/services/awgService');
  return migratePadding(createAwgService(env), {managed:true});
}
if (require.main === module) {
  if (!process.argv[2]) {console.error('Installation directory is required.'); process.exitCode=1;}
  else installedMigration(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(()=>{
    // No environment values, keys, profiles or request bodies in public output.
    console.error('Padding migration failed. Check the panel; existing recovery data is preserved.');
    process.exitCode=1;
  });
}
module.exports = {migratePadding, installedMigration};
