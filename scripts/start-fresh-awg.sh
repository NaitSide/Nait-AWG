#!/usr/bin/env bash
# Adapted from Nait-AWG-Node/scripts/start-awg.sh, using the official AWG layout.
set -Eeuo pipefail
readonly AWG_CONFIG=/opt/amnezia/awg/awg0.conf
readonly AWG_SUBNET=10.8.1.0/24
awg-quick down "$AWG_CONFIG" >/dev/null 2>&1 || true
[[ -f "$AWG_CONFIG" ]] || { echo 'AWG configuration is missing.' >&2; exit 1; }
awg-quick up "$AWG_CONFIG"
add_rule() { iptables -C "$@" >/dev/null 2>&1 || iptables -A "$@"; }
add_nat_rule() { iptables -t nat -C "$@" >/dev/null 2>&1 || iptables -t nat -A "$@"; }
add_rule INPUT -i awg0 -j ACCEPT
add_rule FORWARD -i awg0 -j ACCEPT
add_rule OUTPUT -o awg0 -j ACCEPT
add_rule FORWARD -i awg0 -o eth0 -s "$AWG_SUBNET" -j ACCEPT
add_rule FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT
add_nat_rule POSTROUTING -s "$AWG_SUBNET" -o eth0 -j MASQUERADE
touch /run/nait-awg-ready
exec tail -f /dev/null
