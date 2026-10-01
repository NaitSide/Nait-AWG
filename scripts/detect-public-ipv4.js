const { execFileSync } = require('node:child_process');
const net = require('node:net');

function isPublicIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function detectPublicIpv4({ route, sshConnection } = {}) {
  const routeIp = route?.match(/(?:^|\s)src\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\s|$)/)?.[1];
  const sshIp = sshConnection?.split(/\s+/)?.[2];
  return [routeIp, sshIp].find(isPublicIpv4) || '';
}

if (require.main === module) {
  let route = '';
  try {
    route = execFileSync('ip', ['-4', 'route', 'get', '1.1.1.1'], { encoding: 'utf8', timeout: 3000 });
  } catch { /* No reliable route: let the user enter the address. */ }
  process.stdout.write(detectPublicIpv4({ route, sshConnection: process.env.SSH_CONNECTION }) + '\n');
}

module.exports = { isPublicIpv4, detectPublicIpv4 };
