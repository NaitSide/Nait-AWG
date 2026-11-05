'use strict';
const crypto=require('node:crypto');
// Synthetic public ranges with deliberate gaps, large enough to exercise country-sized exports.
function geoipFixture(alternate=false){
  const ipv4=[];
  for(let second=0;second<256;second++)for(let third=0;third<256;third+=8)ipv4.push(`45.${second}.${third}.0/22`);
  if(alternate){ipv4.pop();ipv4.push('46.0.0.0/22');}
  const body=ipv4.join('\n')+'\n';
  const checksums=crypto.createHash('md5').update(body).digest('hex')+'  ru-aggregated.zone\n';
  return {ipv4,body,checksums};
}
module.exports={geoipFixture};
