'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {validateState}=require('./clientPolicyService');
function migrateRoutingDatabase(filename) {
  if(!fs.existsSync(filename))return {status:'unchanged'};
  const db=new DatabaseSync(filename);let changed=false;
  try {
    const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='client_policies'").get();
    if(!table)return {status:'unchanged'};
    db.exec('BEGIN IMMEDIATE');
    try {
      const row=db.prepare('SELECT state FROM client_policies WHERE id=1').get();
      if(row){
        const previous=JSON.parse(row.state),next=validateState(previous);
        if(JSON.stringify(previous)!==JSON.stringify(next)) {
          next.revision=previous.revision+1;
          db.prepare('UPDATE client_policies SET state=? WHERE id=1').run(JSON.stringify(next));changed=true;
        }
      }
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
  return {status:changed?'applied':'unchanged'};
}
function installedMigration(directory) {
  const root=path.resolve(directory);
  const localRequire=require('node:module').createRequire(path.join(root,'package.json'));
  const env=localRequire('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
  const database=path.resolve(root,env.NAIT_AWG_DATA_PATH || './data/clients.db');
  const result=migrateRoutingDatabase(database);
  // The sole compatibility cleanup for the removed country-list feature.
  const retired=path.join(path.dirname(database),'geoip-ru.json');
  try {if(fs.lstatSync(retired).isFile())fs.unlinkSync(retired);}catch(error){if(error.code!=='ENOENT')throw error;}
  return result;
}
if(require.main===module){
  try {if(!process.argv[2])throw Error();console.log(JSON.stringify(installedMigration(process.argv[2])));}
  catch {console.error('Routing migration failed; existing policies were not replaced with empty data.');process.exitCode=1;}
}
module.exports={migrateRoutingDatabase,installedMigration};
