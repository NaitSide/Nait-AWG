#!/usr/bin/env bash
# Fresh VPS bootstrap with a bundled official runtime; never replace another VPN.
set -Eeuo pipefail
readonly SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly STATE_DIR=/opt/naitlab/nait_awg_runtime
readonly CONTAINER=amnezia-awg2
fail() { printf "$(installer_text 'Ошибка: %s\n' 'Error: %s\n')" "$*" >&2; if declare -F installer_log_hint >/dev/null; then installer_log_hint; fi; exit 1; }
note() { printf '%s\n' "$*" >&2; }
source "$SOURCE_DIR/scripts/installer-output.sh"
source "$SOURCE_DIR/scripts/load-awg-image.sh"
port_free() {
  local listeners
  listeners="$(ss -H "$1" "( sport = :$2 )")" || fail "$(installer_text 'Не удалось проверить занятость порта.' 'Could not check whether the port is in use.')"
  [[ -z "$listeners" ]]
}

assert_fresh() {
  for target in /opt/naitlab/nait_awg /opt/naitlab/nait_awg_node "$STATE_DIR" /opt/amnezia /etc/amnezia /etc/wireguard /etc/openvpn /var/lib/tailscale; do
    [[ ! -e "$target" && ! -L "$target" ]] || fail "$(installer_text "Обнаружена существующая установка: $target. Пункт 2 предназначен для чистого сервера." "Existing installation detected: $target. Option 2 requires a clean server.")"
  done
  for unit in nait-awg-selfhost.service nait-awg-receiver-selfhost.service nait-awg-receiver.service; do
    [[ "$(systemctl show "$unit" --property=LoadState --value)" == not-found ]] || fail "$(installer_text "Обнаружена служба $unit. Ничего не заменяем." "Service $unit detected. Nothing will be replaced.")"
  done
  port_free -ltn 42842 || fail "$(installer_text 'Внутренний TCP-порт 42842 занят.' 'Internal TCP port 42842 is in use.')"
  local links
  links="$(ip -o link show)" || fail "$(installer_text 'Не удалось проверить сетевые интерфейсы.' 'Could not check network interfaces.')"
  if printf '%s\n' "$links" | grep -Eq '^[0-9]+: (awg|wg|tun|tap|tailscale)[^: ]*[:@]'; then fail "$(installer_text 'Обнаружен работающий VPN-интерфейс.' 'A running VPN interface was detected.')"; fi
  if command -v docker >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || fail "$(installer_text 'Docker установлен, но недоступен. Проверьте его самостоятельно; чужие службы не запускаем.' 'Docker is installed but unavailable. Check it manually; other services will not be started.')"
    local names
    names="$(docker ps -a --format '{{.Names}}')" || fail "$(installer_text 'Не удалось прочитать контейнеры.' 'Could not read the container list.')"
    [[ -z "$names" ]] || fail "$(installer_text 'На сервере уже есть контейнеры, в том числе остановленные. Совместная установка отменена; используйте пункт 1 для существующего AWG.' 'The server already has containers, including stopped ones. Combined installation cancelled; use option 1 for an existing AWG.')"
  elif [[ -e /var/lib/docker || -e /etc/docker || -e /var/lib/containerd ]]; then
    fail "$(installer_text 'Найдены данные прежнего Docker/containerd. Совместная установка отменена.' 'Data from a previous Docker/containerd installation was found. Combined installation cancelled.')"
  fi
}

[[ "$EUID" -eq 0 && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail "$(installer_text 'Требуются root и Linux x86_64.' 'root and Linux x86_64 are required.')"
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail "$(installer_text 'Поддерживается Ubuntu 24.04 x86_64.' 'Ubuntu 24.04 x86_64 is supported.')"
for cmd in systemctl ss ip grep; do command -v "$cmd" >/dev/null || fail "$(installer_text "Нужна команда $cmd." "Command $cmd is required.")"; done
case "${1:-}" in check|prepare|install) ;; *) fail "$(installer_text 'Использование: install-fresh-awg.sh check|prepare|install [node] [UDP-port]' 'Usage: install-fresh-awg.sh check|prepare|install [node] [UDP-port]')" ;; esac
verify_awg_archive
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
    run_logged "$(installer_text 'Обновляем список пакетов Ubuntu...' 'Updating the Ubuntu package list...')" apt-get update
    run_logged "$(installer_text 'Устанавливаем Docker и необходимые пакеты...' 'Installing Docker and required packages...')" apt-get install -y --no-install-recommends ca-certificates "${missing[@]}"
  fi
  [[ -c /dev/net/tun ]] || modprobe tun
  [[ -c /dev/net/tun ]] || fail "$(installer_text 'TUN недоступен. Проверьте ограничения виртуализации у провайдера.' 'TUN is unavailable. Check virtualization restrictions with your provider.')"
  run_logged "$(installer_text 'Подготавливаем Docker...' 'Preparing Docker...')" systemctl enable --now docker
  docker info >/dev/null
  exit 0
fi

node="${2:?Node path is required}"
port="${3:?UDP port is required}"
[[ -x "$node" && "$port" =~ ^[0-9]{1,5}$ ]] || fail "$(installer_text 'Не указан Node.js или UDP-порт.' 'Node.js or UDP port was not specified.')"
port=$((10#$port))
(( port >= 1024 && port <= 65535 )) || fail "$(installer_text 'UDP-порт должен быть от 1024 до 65535.' 'UDP port must be from 1024 to 65535.')"
port_free -lun "$port" || fail "$(installer_text "UDP-порт $port занят." "UDP port $port is in use.")"
ip -j -4 route show table all | "$node" "$SOURCE_DIR/scripts/fresh-awg-config.js" routes || fail "$(installer_text 'Подсеть 10.8.1.0/24 пересекается с существующим маршрутом или маршруты недоступны.' 'Subnet 10.8.1.0/24 overlaps an existing route, or routes are unavailable.')"

load_awg_image
verify_awg_tools
# Recheck after loading, before generating or persisting any node state.
assert_fresh
check_result="$(ss -H -lun "( sport = :$port )")"
[[ -z "$check_result" ]] || fail "$(installer_text "UDP-порт $port заняли во время подготовки." "UDP port $port became occupied during preparation.")"
private_key="$(docker run --pull=never --rm --network none --entrypoint awg "$IMAGE" genkey)"
public_key="$(printf '%s\n' "$private_key" | docker run --pull=never --rm --network none -i --entrypoint awg "$IMAGE" pubkey)"
header_key="$(docker run --pull=never --rm --network none --entrypoint awg "$IMAGE" genkey)"
note "$(installer_text 'Настраиваем AmneziaWG...' 'Configuring AmneziaWG...')"
install -d -m 0755 /opt/naitlab
diagnose_failure() {
  if [[ $? -ne 0 && -d "$STATE_DIR" ]]; then
    note "$(installer_text "AWG не прошёл проверку. Ключи и конфиг сохранены в $STATE_DIR; автоматически ничего не удаляем." "AWG verification failed. Keys and config are preserved in $STATE_DIR; nothing will be deleted automatically.")"
    note "$(installer_text "Проверьте: sudo docker logs $CONTAINER. Пункт 2 не перезаписывает частичную установку." "Check: sudo docker logs $CONTAINER. Option 2 does not overwrite a partial installation.")"
  fi
}
trap diagnose_failure EXIT
umask 077
printf '%s\n%s\n%s\n' "$private_key" "$public_key" "$header_key" | "$node" "$SOURCE_DIR/scripts/fresh-awg-config.js" write "$STATE_DIR" "$port"
unset private_key header_key
install -m 0755 "$SOURCE_DIR/scripts/start-fresh-awg.sh" "$STATE_DIR/start-awg.sh"
run_logged "$(installer_text 'Запускаем AmneziaWG...' 'Starting AmneziaWG...')" docker run --pull=never -d --init --log-opt max-size=2m --log-opt max-file=2 --restart always \
  --privileged --cap-add NET_ADMIN --cap-add SYS_MODULE \
  --sysctl net.ipv4.ip_forward=1 --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  -p "$port:$port/udp" -v /lib/modules:/lib/modules:ro \
  -v "$STATE_DIR:/opt/amnezia/awg" -v "$STATE_DIR/start-awg.sh:/opt/amnezia/start.sh:ro" \
  --label org.nait-awg.managed=fresh-v1 --name "$CONTAINER" \
  --entrypoint /bin/bash "$IMAGE" /opt/amnezia/start.sh
note "$(installer_text 'Проверяем запуск AmneziaWG...' 'Checking AmneziaWG startup...')"
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
[[ "$ready" == true ]] || fail "$(installer_text 'Контейнер не поднял проверенный интерфейс AWG.' 'The container did not bring up a verified AWG interface.')"
[[ -z "$(docker exec "$CONTAINER" awg show awg0 peers)" ]] || fail "$(installer_text 'На новой ноде обнаружены неожиданные клиенты.' 'Unexpected clients were found on the new node.')"
"$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" >/dev/null || fail "$(installer_text 'Новая нода не прошла проверку совместимости с панелью.' 'The new node did not pass the panel compatibility check.')"
printf 'FORMAT=1\nCONTAINER=%s\nIMAGE=%s\nUDP_PORT=%s\n' "$CONTAINER" "$IMAGE" "$port" > "$STATE_DIR/installed.env"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  run_logged "$(installer_text "Открываем UDP-порт $port в UFW для VPN..." "Opening UDP port $port in UFW for VPN...")" ufw allow "$port/udp" comment 'Nait-AWG VPN'
fi
note "$(installer_text "AmneziaWG 3.1 работает. UDP-порт: $port. Клиентов пока нет — выдайте доступ в панели." "AmneziaWG 3.1 is running. UDP port: $port. No clients yet; add a client in the panel.")"
