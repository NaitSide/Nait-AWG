#!/usr/bin/env bash
# Fresh VPS bootstrap adapted from Nait-AWG-Node; never adopt/replace another VPN.
set -Eeuo pipefail
readonly SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly STATE_DIR=/opt/naitlab/nait_awg_runtime
readonly CONTAINER=amnezia-awg2
# Official linux/amd64 manifest, verified against Docker Hub on 2026-10-05.
readonly IMAGE=amneziavpn/amneziawg-go@sha256:c68009d33df3aef4654db72bf1a7880cfa0a631fe866c50d9ae3dd34ddd7c13a
readonly IMAGE_ID=sha256:9d73b5cb2089bdf1deabfbb9fe95a930853b2d1ff83017805e29a6a9e13c2273
fail() { printf 'Ошибка: %s\n' "$*" >&2; if declare -F installer_log_hint >/dev/null; then installer_log_hint; fi; exit 1; }
note() { printf '%s\n' "$*" >&2; }
source "$SOURCE_DIR/scripts/installer-output.sh"
port_free() {
  local listeners
  listeners="$(ss -H "$1" "( sport = :$2 )")" || fail 'Не удалось проверить занятость порта.'
  [[ -z "$listeners" ]]
}

assert_fresh() {
  for target in /opt/naitlab/nait_awg /opt/naitlab/nait_awg_node "$STATE_DIR" /opt/amnezia /etc/amnezia /etc/wireguard /etc/openvpn /var/lib/tailscale; do
    [[ ! -e "$target" && ! -L "$target" ]] || fail "Обнаружена существующая установка: $target. Пункт 2 предназначен для чистого сервера."
  done
  for unit in nait-awg-selfhost.service nait-awg-receiver-selfhost.service nait-awg-receiver.service; do
    [[ "$(systemctl show "$unit" --property=LoadState --value)" == not-found ]] || fail "Обнаружена служба $unit. Ничего не заменяем."
  done
  port_free -ltn 42842 || fail 'Внутренний TCP-порт 42842 занят.'
  local links
  links="$(ip -o link show)" || fail 'Не удалось проверить сетевые интерфейсы.'
  if printf '%s\n' "$links" | grep -Eq '^[0-9]+: (awg|wg|tun|tap|tailscale)[^: ]*[:@]'; then fail 'Обнаружен работающий VPN-интерфейс.'; fi
  if command -v docker >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || fail 'Docker установлен, но недоступен. Проверьте его самостоятельно; чужие службы не запускаем.'
    local names
    names="$(docker ps -a --format '{{.Names}}')" || fail 'Не удалось прочитать контейнеры.'
    [[ -z "$names" ]] || fail 'На сервере уже есть контейнеры, в том числе остановленные. Совместная установка отменена; используйте пункт 1 для существующего AWG.'
  elif [[ -e /var/lib/docker || -e /etc/docker || -e /var/lib/containerd ]]; then
    fail 'Найдены данные прежнего Docker/containerd. Совместная установка отменена.'
  fi
}

[[ "$EUID" -eq 0 && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'Требуются root и Linux x86_64.'
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail 'Поддерживается Ubuntu 24.04 x86_64.'
for cmd in systemctl ss ip grep; do command -v "$cmd" >/dev/null || fail "Нужна команда $cmd."; done
case "${1:-}" in check|prepare|install) ;; *) fail 'Использование: install-fresh-awg.sh check|prepare|install [node] [UDP-port]' ;; esac
assert_fresh
if [[ "$1" == check ]]; then exit 0; fi
installer_log_init
if [[ "$1" == prepare ]]; then
  missing=()
  for pair in docker:docker.io xz:xz-utils openssl:openssl sha256sum:coreutils modprobe:kmod flock:util-linux; do
    command -v "${pair%%:*}" >/dev/null 2>&1 || missing+=("${pair#*:}")
  done
  if (( ${#missing[@]} )); then
    export DEBIAN_FRONTEND=noninteractive
    run_logged 'Обновляем список пакетов Ubuntu...' apt-get update
    run_logged 'Устанавливаем Docker и необходимые пакеты...' apt-get install -y --no-install-recommends ca-certificates "${missing[@]}"
  fi
  [[ -c /dev/net/tun ]] || modprobe tun
  [[ -c /dev/net/tun ]] || fail 'TUN недоступен. Проверьте ограничения виртуализации у провайдера.'
  run_logged 'Запускаем Docker...' systemctl enable --now docker
  docker info >/dev/null
  exit 0
fi

node="${2:?Node path is required}"
port="${3:?UDP port is required}"
[[ -x "$node" && "$port" =~ ^[0-9]{1,5}$ ]] || fail 'Не указан Node.js или UDP-порт.'
port=$((10#$port))
(( port >= 1024 && port <= 65535 )) || fail 'UDP-порт должен быть от 1024 до 65535.'
port_free -lun "$port" || fail "UDP-порт $port занят."
ip -j -4 route show table all | "$node" "$SOURCE_DIR/scripts/fresh-awg-config.js" routes || fail 'Подсеть 10.8.1.0/24 пересекается с существующим маршрутом или маршруты недоступны.'

run_logged 'Загружаем официальный Docker-образ AmneziaWG 3.1...' docker pull --platform linux/amd64 "$IMAGE"
[[ "$(docker image inspect "$IMAGE" --format '{{.Id}}')" == "$IMAGE_ID" ]] || fail 'Идентификатор образа не совпал.'
[[ "$(docker image inspect "$IMAGE" --format '{{.Architecture}}')" == amd64 ]] || fail 'Архитектура образа не совпала.'
tools_version="$(docker run --rm --network none --entrypoint awg "$IMAGE" --version)"
[[ "$tools_version" == 'amneziawg-tools v3.1.20260812' ]] || fail 'Официальный образ не содержит ожидаемый AWG 3.1.'
# Recheck after the download, before generating or persisting any node state.
assert_fresh
check_result="$(ss -H -lun "( sport = :$port )")"
[[ -z "$check_result" ]] || fail "UDP-порт $port заняли во время подготовки."
private_key="$(docker run --rm --network none --entrypoint awg "$IMAGE" genkey)"
public_key="$(printf '%s\n' "$private_key" | docker run --rm --network none -i --entrypoint awg "$IMAGE" pubkey)"
header_key="$(docker run --rm --network none --entrypoint awg "$IMAGE" genkey)"
note 'Настраиваем AmneziaWG...'
install -d -m 0755 /opt/naitlab
diagnose_failure() {
  if [[ $? -ne 0 && -d "$STATE_DIR" ]]; then
    note "AWG не прошёл проверку. Ключи и конфиг сохранены в $STATE_DIR; автоматически ничего не удаляем."
    note "Проверьте: sudo docker logs $CONTAINER. Пункт 2 не перезаписывает частичную установку."
  fi
}
trap diagnose_failure EXIT
umask 077
printf '%s\n%s\n%s\n' "$private_key" "$public_key" "$header_key" | "$node" "$SOURCE_DIR/scripts/fresh-awg-config.js" write "$STATE_DIR" "$port"
unset private_key header_key
install -m 0755 "$SOURCE_DIR/scripts/start-fresh-awg.sh" "$STATE_DIR/start-awg.sh"
run_logged 'Запускаем AmneziaWG...' docker run -d --init --log-opt max-size=2m --log-opt max-file=2 --restart always \
  --privileged --cap-add NET_ADMIN --cap-add SYS_MODULE \
  --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -p "$port:$port/udp" -v /lib/modules:/lib/modules:ro \
  -v "$STATE_DIR:/opt/amnezia/awg" -v "$STATE_DIR/start-awg.sh:/opt/amnezia/start.sh:ro" \
  --label org.nait-awg.managed=fresh-v1 --name "$CONTAINER" \
  --entrypoint /bin/bash "$IMAGE" /opt/amnezia/start.sh
note 'Проверяем запуск AmneziaWG...'
ready=false
for attempt in {1..30}; do
  if [[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" == true ]] \
    && docker exec "$CONTAINER" test -f /run/nait-awg-ready \
    && [[ "$(docker exec "$CONTAINER" awg show awg0 listen-port 2>/dev/null)" == "$port" ]] \
    && [[ "$(docker exec "$CONTAINER" awg show awg0 public-key 2>/dev/null)" == "$public_key" ]]; then
    ready=true; break
  fi
  sleep 1
done
[[ "$ready" == true ]] || fail 'Контейнер не поднял проверенный интерфейс AWG.'
[[ -z "$(docker exec "$CONTAINER" awg show awg0 peers)" ]] || fail 'На новой ноде обнаружены неожиданные клиенты.'
"$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" >/dev/null || fail 'Новая нода не прошла проверку совместимости с панелью.'
printf 'FORMAT=1\nCONTAINER=%s\nIMAGE=%s\nUDP_PORT=%s\n' "$CONTAINER" "$IMAGE" "$port" > "$STATE_DIR/installed.env"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  run_logged "Открываем UDP-порт $port в UFW для VPN..." ufw allow "$port/udp" comment 'Nait-AWG VPN'
fi
note "AmneziaWG 3.1 работает. UDP-порт: $port. Клиентов пока нет — выдайте доступ в панели."
