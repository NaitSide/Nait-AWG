#!/usr/bin/env bash
# Fetch the public Nait-AWG source and run its existing-AWG installer.
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || { printf 'Запустите через sudo.\n' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { printf 'Нужен curl.\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf 'Нужен tar.\n' >&2; exit 1; }

stage="$(mktemp -d /tmp/nait-awg-bootstrap.XXXXXX)"
cleanup() { if [[ "$stage" == /tmp/nait-awg-bootstrap.* && -d "$stage" ]]; then rm -rf -- "$stage"; fi; }
trap cleanup EXIT

curl --fail --location --retry 3 --silent --show-error \
  https://github.com/NaitSide/Nait-AWG/archive/refs/heads/main.tar.gz \
  -o "$stage/source.tar.gz"
tar -xzf "$stage/source.tar.gz" -C "$stage"
source_dir="$stage/Nait-AWG-main"
[[ -f "$source_dir/install-selfhost.sh" && -f "$source_dir/scripts/selfhost-preflight.js" ]] || {
  printf 'Архив проекта неполный. Установка отменена.\n' >&2
  exit 1
}
bash "$source_dir/install-selfhost.sh" install
