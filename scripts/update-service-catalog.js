'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateCatalog, catalog} = require('../app/services/routingService');

// Maintainer tool: accepts a prepared JSON snapshot, never downloads or executes it.
function installCatalog(candidate, destination = path.join(__dirname,'../app/data/service-catalog.json')) {
  if (fs.statSync(candidate).size > 256 * 1024) throw new Error('Catalog exceeds 256 KiB');
  const next = validateCatalog(JSON.parse(fs.readFileSync(candidate,'utf8')));
  if (next.date < catalog.date || catalog.services.some(service=>!next.services.some(item=>item.id===service.id))) {
    throw new Error('Catalog date or stable service IDs would regress');
  }
  const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
  try {
    const descriptor = fs.openSync(temporary,'wx',0o600);
    try {fs.writeFileSync(descriptor,JSON.stringify(next,null,2)+'\n');fs.fchmodSync(descriptor,0o644);fs.fsyncSync(descriptor);}
    finally {fs.closeSync(descriptor);}
    fs.renameSync(temporary,destination);
  } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
if (require.main === module) {
  if (process.argv.length !== 3) {console.error('Usage: node scripts/update-service-catalog.js SNAPSHOT.json');process.exitCode=2;}
  else {try {installCatalog(path.resolve(process.argv[2]));console.log('Catalog saved. Restart the panel; saved route policies keep their previous snapshot until explicitly saved again.');}
    catch(error) {console.error(error.message);process.exitCode=1;}}
}
module.exports = {installCatalog};
