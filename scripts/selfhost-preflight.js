'use strict';

// Read-only compatibility check for an AmneziaVPN Self-hosted AWG 3.1 node.
// No config, private key, peer key or endpoint is written to stdout.
const { execFileSync } = require('node:child_process');
const { getAwgProfile, getAwgPeers } = require('../vendor/receiver/src/services/awgService');

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).trim();
}

function selectContainer(names) {
  const candidates = names.filter((name) => /^(amnezia-awg|amnezia-awg2)$/.test(name));
  if (candidates.length !== 1) throw new Error(`Expected exactly one AWG container; found ${candidates.length}.`);
  return candidates[0];
}

async function audit() {
  const names = docker(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/).filter(Boolean);
  const container = selectContainer(names);
  const inspect = JSON.parse(docker(['inspect', container]))[0];
  if (inspect?.State?.Running !== true) throw new Error(`AWG container ${container} is not running.`);
  const startedAt = String(inspect.State.StartedAt || '');
  if (!/^\d{4}-\d\d-\d\dT/.test(startedAt)) throw new Error('Cannot verify AWG start time.');
  process.env.AWG_CONTAINER_NAME = container;
  process.env.AWG_INTERFACE = 'awg0';
  process.env.AWG_CONFIG_PATH = '/opt/amnezia/awg/awg0.conf';
  process.env.AWG_CONTAINER_CONFIG_PATH = '/opt/amnezia/awg/awg0.conf';
  const [profile, inventory] = await Promise.all([getAwgProfile(), getAwgPeers()]);
  if (profile.status !== 'ok' || profile.protocolVersion !== '3.1') {
    const detail = profile.errorDetail ? `: ${profile.errorDetail}` : '';
    throw new Error(`AWG 3.1 profile check failed (${profile.error || profile.status}${detail}).`);
  }
  if (inventory.status !== 'ok' || !Array.isArray(inventory.persistentPeers)) {
    throw new Error('Cannot read persistent AWG peer inventory.');
  }
  const subnet = String(profile.tunnelSubnet || '');
  if (!/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(subnet)) throw new Error('Cannot determine AWG VPN subnet.');
  const persistent = new Set(inventory.persistentPeers.map((peer) => peer.publicKey));
  if (persistent.size !== inventory.persistentPeers.length) throw new Error('Duplicate persistent peer keys detected.');
  for (const peer of inventory.peers) {
    if (!persistent.has(peer.publicKey)) throw new Error('A runtime peer is absent from persistent config.');
  }
  return { container, subnet, startedAt, runtimePeers: inventory.peers.length, persistentPeers: persistent.size };
}

if (require.main === module) {
  audit().then((result) => {
    if (process.argv.includes('--machine')) {
      process.stdout.write(`${result.container}\t${result.subnet}\t${result.startedAt}\n`);
    } else {
      process.stdout.write(`AWG 3.1: ${result.container}, subnet ${result.subnet}, runtime peers ${result.runtimePeers}, persistent peers ${result.persistentPeers}. No changes made.\n`);
    }
  }).catch((error) => { console.error(`Preflight failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { selectContainer };
