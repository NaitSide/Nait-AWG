#!/usr/bin/env bash
# Download Nait-AWG when piped from GitHub, or install it from a local checkout.
# Add the panel to an existing AmneziaVPN Self-hosted AWG 3.1 node.
# This script never starts, stops, restarts, creates or replaces the AWG container.
set -Eeuo pipefail

if [[ "${1:-}" != install && "${1:-}" != audit ]]; then
  [[ $# -eq 0 ]] || { printf 'Использование: sudo bash install.sh [audit|install]\n' >&2; exit 2; }
  [[ "${EUID}" -eq 0 ]] || { printf 'Запустите через sudo.\n' >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { printf 'Нужен curl.\n' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { printf 'Нужен tar.\n' >&2; exit 1; }

  if [[ -e /opt/naitlab/nait_awg || -e /etc/systemd/system/nait-awg-selfhost.service ]]; then
    printf 'Nait-AWG уже установлен. Повторная установка остановлена; работающая панель не изменена.\n' >&2
    exit 1
  fi

  if command -v hostname >/dev/null 2>&1 && command -v getent >/dev/null 2>&1; then
    server_name="$(hostname)"
    if [[ -n "$server_name" ]] && ! getent hosts "$server_name" >/dev/null; then
      printf 'Имя сервера %s не находится в /etc/hosts. Это вызывает предупреждение sudo; инструкция есть в README.\n' "$server_name" >&2
    fi
  fi

  download_stage="$(mktemp -d /tmp/nait-awg-download.XXXXXX)"
  cleanup_download() { if [[ "$download_stage" == /tmp/nait-awg-download.* && -d "$download_stage" ]]; then rm -rf -- "$download_stage"; fi; }
  trap cleanup_download EXIT

  printf 'Загружаем Nait-AWG с GitHub...\n' >&2
  curl --fail --location --retry 3 --silent --show-error \
    https://github.com/NaitSide/Nait-AWG/archive/refs/heads/main.tar.gz \
    -o "$download_stage/source.tar.gz"
  tar -xzf "$download_stage/source.tar.gz" -C "$download_stage"
  source_dir="$download_stage/Nait-AWG-main"
  [[ -f "$source_dir/install.sh" && -f "$source_dir/scripts/selfhost-preflight.js" ]] || {
    printf 'Архив проекта неполный. Установка отменена.\n' >&2
    exit 1
  }
  printf 'Проверяем совместимость сервера с AmneziaWG...\n' >&2
  bash "$source_dir/install.sh" install
  exit 0
fi

readonly SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INSTALL_DIR=/opt/naitlab/nait_awg
readonly PANEL_UNIT=nait-awg-selfhost.service
readonly RECEIVER_UNIT=nait-awg-receiver-selfhost.service
readonly NODE_ARCHIVE=node-v24.20.0-linux-x64.tar.xz
readonly NODE_SHA256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
stage=''

fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }
cleanup() { if [[ "$stage" == /tmp/nait-awg.* && -d "$stage" ]]; then rm -rf -- "$stage"; fi; }
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || fail 'Run via sudo/root.'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'Only Linux x86_64 is supported.'
[[ -r /etc/os-release ]] || fail 'Cannot identify the operating system.'
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail 'Only Ubuntu 24.04 is supported by this installer.'
for command_name in docker curl openssl tar xz sha256sum systemctl ss getent useradd groupadd usermod; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Missing command: $command_name"
done
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/vendor/receiver/package-lock.json" && -f "$SOURCE_DIR/scripts/selfhost-preflight.js" && -f "$SOURCE_DIR/scripts/detect-public-ipv4.js" ]] || fail 'Run from a complete Nait-AWG source checkout.'

if [[ "${1:-}" == install ]]; then
  [[ ! -e "$INSTALL_DIR" ]] || fail "Nait-AWG уже установлен: $INSTALL_DIR. Повторная установка остановлена; файлы не изменены."
  [[ ! -e "/etc/systemd/system/$PANEL_UNIT" && ! -e "/etc/systemd/system/$RECEIVER_UNIT" ]] || fail 'Обнаружены службы Nait-AWG. Повторная установка остановлена; проверьте существующую установку.'
  [[ -z "$(ss -H -ltn '( sport = :42842 )')" ]] || fail 'Внутренний TCP-порт 42842 уже занят. Проверьте, не установлен ли Nait-AWG.'
elif [[ "${1:-}" != audit ]]; then
  printf 'Использование: sudo bash install.sh [audit|install]\n' >&2
  exit 2
fi

# The pinned Node archive may be supplied offline; otherwise fetch the official release.
note 'Готовим проверку сервера...'
stage="$(mktemp -d /tmp/nait-awg.XXXXXX)"
if [[ -n "${NAIT_AWG_NODE_ARCHIVE:-}" ]]; then
  [[ -f "$NAIT_AWG_NODE_ARCHIVE" ]] || fail 'NAIT_AWG_NODE_ARCHIVE is not a readable file.'
  cp -- "$NAIT_AWG_NODE_ARCHIVE" "$stage/$NODE_ARCHIVE"
else
  curl --fail --location --retry 3 --silent --show-error \
    "https://nodejs.org/dist/v24.20.0/$NODE_ARCHIVE" -o "$stage/$NODE_ARCHIVE"
fi
printf '%s  %s\n' "$NODE_SHA256" "$stage/$NODE_ARCHIVE" | sha256sum --check --status || fail 'Node archive checksum mismatch.'
tar -xJf "$stage/$NODE_ARCHIVE" -C "$stage"
node="$stage/node-v24.20.0-linux-x64/bin/node"
npm="$stage/node-v24.20.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js"
[[ -x "$node" && -f "$npm" ]] || fail 'Node archive is incomplete.'

note 'Ищем контейнер AmneziaWG и проверяем его настройки...'
IFS=$'\t' read -r awg_container awg_subnet awg_started_at < <("$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" --machine)
[[ "$awg_container" =~ ^amnezia-awg2?$ && "$awg_subnet" =~ ^[0-9./]+$ && "$awg_started_at" =~ ^[0-9TZ:.-]+$ ]] || fail 'Invalid preflight result.'
note "AmneziaWG 3.1 найден: $awg_container, $awg_subnet. Работающий VPN не трогаем."
if [[ "${1:-}" == audit ]]; then exit 0; fi

public_endpoint="${NAIT_AWG_PUBLIC_ENDPOINT:-}"
if [[ -z "$public_endpoint" && -r /dev/tty ]]; then
  detected_endpoint="$("$node" "$SOURCE_DIR/scripts/detect-public-ipv4.js")"
  if [[ -n "$detected_endpoint" ]]; then
    read -r -p "Публичный IPv4 сервера [$detected_endpoint] (Enter — принять): " public_endpoint </dev/tty
    public_endpoint="${public_endpoint:-$detected_endpoint}"
  else
    read -r -p 'Введите публичный IPv4 сервера: ' public_endpoint </dev/tty
  fi
fi
[[ "$public_endpoint" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'Set NAIT_AWG_PUBLIC_ENDPOINT to a public IPv4 address.'
IFS=. read -r octet1 octet2 octet3 octet4 <<< "$public_endpoint"
for octet in "$octet1" "$octet2" "$octet3" "$octet4"; do
  (( 10#$octet <= 255 )) || fail 'Invalid public IPv4 address.'
done
panel_port="${NAIT_AWG_PANEL_PORT:-}"
if [[ -z "$panel_port" ]]; then
  suggested_panel_port=''
  for attempt in {1..40}; do
    candidate_port="$("$node" -e 'process.stdout.write(String(require("node:crypto").randomInt(20000, 60001)))')"
    if [[ "$candidate_port" != 42842 && -z "$(ss -H -ltn "( sport = :$candidate_port )")" ]]; then
      suggested_panel_port="$candidate_port"
      break
    fi
  done
  [[ -n "$suggested_panel_port" ]] || fail 'Не удалось подобрать свободный порт для панели.'
  if [[ -r /dev/tty ]]; then
    read -r -p "Порт веб-панели [$suggested_panel_port] (Enter — принять): " panel_port </dev/tty
    panel_port="${panel_port:-$suggested_panel_port}"
  else
    fail 'Укажите порт панели через NAIT_AWG_PANEL_PORT.'
  fi
fi
[[ "$panel_port" =~ ^[0-9]{1,5}$ ]] || fail 'Порт панели должен быть числом от 1024 до 65535.'
panel_port=$((10#$panel_port))
(( panel_port >= 1024 && panel_port <= 65535 )) || fail 'Порт панели должен быть числом от 1024 до 65535.'
[[ "$panel_port" != 42842 ]] || fail 'Порт 42842 зарезервирован для внутреннего сервиса.'
[[ -z "$(ss -H -ltn "( sport = :$panel_port )")" ]] || fail "TCP-порт $panel_port уже занят. Запустите установку заново и выберите другой."
admin_password="${NAIT_AWG_ADMIN_PASSWORD:-}"
if [[ -z "$admin_password" && -r /dev/tty ]]; then
  read -r -s -p 'Пароль администратора панели (от 12 символов): ' admin_password </dev/tty
  printf '\n' >&2
  read -r -s -p 'Повторите пароль: ' admin_password_repeat </dev/tty
  printf '\n' >&2
  [[ "$admin_password" == "$admin_password_repeat" ]] || fail 'Пароли не совпадают. Запустите установку заново.'
fi
[[ "${#admin_password}" -ge 12 && "$admin_password" =~ ^[a-zA-Z0-9@#%^*_.!+-]+$ ]] || fail 'Admin password must be 12+ characters and use letters, digits or @#%^*_.!+-.'

# Recheck before writing; a running VPN is not sufficient if its config/profile is stale.
"$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" >/dev/null
[[ "$(docker inspect --format '{{.State.StartedAt}}' "$awg_container")" == "$awg_started_at" ]] || fail 'AWG container restarted during preflight; retry later.'

note 'Устанавливаем панель. Контейнер VPN перезапускать не будем...'
install -d -m 0755 /opt/naitlab
install -d -m 0750 "$stage/receiver" "$stage/data" "$stage/tls" "$stage/runtime"
cp -R -- "$SOURCE_DIR/app" "$SOURCE_DIR/package.json" "$stage/"
cp -R -- "$SOURCE_DIR/vendor/receiver/." "$stage/receiver/"
cp -R -- "$stage/node-v24.20.0-linux-x64/." "$stage/runtime/"
note 'Устанавливаем библиотеки веб-панели...'
PATH="$stage/runtime/bin:$PATH" "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" install --prefix "$stage" --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
note 'Устанавливаем библиотеки внутреннего сервиса...'
PATH="$stage/runtime/bin:$PATH" "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage/receiver" --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
rm -f -- "$stage/$NODE_ARCHIVE"
rm -rf -- "$stage/node-v24.20.0-linux-x64"

if ! getent group nait-awg >/dev/null; then groupadd --system nait-awg; fi
if ! getent passwd nait-awg >/dev/null; then
  useradd --system --gid nait-awg --groups docker --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin nait-awg
fi
getent group docker | grep -qw nait-awg || usermod -aG docker nait-awg
nait_awg_gid="$(getent group nait-awg | cut -d: -f3)"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout "$stage/tls/key.pem" -out "$stage/tls/cert.pem" \
  -subj "/CN=$public_endpoint" -addext "subjectAltName=IP:$public_endpoint" >/dev/null 2>&1
receiver_key="$(openssl rand -base64 32 | tr -d '\n')"
session_secret="$(openssl rand -base64 32 | tr -d '\n')"
data_key="$(openssl rand -base64 32 | tr -d '\n')"
node_id="$(cat /proc/sys/kernel/random/uuid)"
cat > "$stage/.env" <<EOF
HOST=0.0.0.0
PORT=$panel_port
TLS_KEY_PATH=$INSTALL_DIR/tls/key.pem
TLS_CERT_PATH=$INSTALL_DIR/tls/cert.pem
COOKIE_SECURE=true
NAIT_AWG_SESSION_SECRET=$session_secret
NAIT_AWG_DATA_KEY=$data_key
NAIT_AWG_ADMIN_PASSWORD=$admin_password
RECEIVER_URL=http://127.0.0.1:42842
RECEIVER_API_KEY=$receiver_key
AWG_CONTAINER_NAME=$awg_container
PUBLIC_ENDPOINT_HOST=$public_endpoint
CLIENT_DNS=1.1.1.1
CLIENT_ALLOWED_IPS=0.0.0.0/0, ::/0
CLIENT_PERSISTENT_KEEPALIVE=25
NAIT_AWG_DATA_PATH=$INSTALL_DIR/data/clients.db
EOF
cat > "$stage/receiver/.env" <<EOF
HOST=127.0.0.1
PORT=42842
RECEIVER_API_KEY=$receiver_key
NODE_ID=$node_id
AWG_CONTAINER_NAME=$awg_container
AWG_INTERFACE=awg0
AWG_CONFIG_PATH=/opt/amnezia/awg/awg0.conf
AWG_CONTAINER_CONFIG_PATH=/opt/amnezia/awg/awg0.conf
AWG_VPN_SUBNET=$awg_subnet
AWG_WRITE_ENABLED=true
AWG_GATE_WRITE_ENABLED=true
AWG_CONFIG_GROUP_ID=$nait_awg_gid
AWG_RECEIVER_TMP_DIR=$INSTALL_DIR/receiver/tmp
AWG_RECEIVER_BACKUP_DIR=$INSTALL_DIR/receiver/backups
AWG_LOCK_DIR=$INSTALL_DIR/receiver/locks
AWG_IDEMPOTENCY_DIR=$INSTALL_DIR/receiver/state/idempotency
AWG_GATE_STATE_DIR=$INSTALL_DIR/receiver/state/gates
EOF
install -d -m 0700 "$stage/receiver/tmp" "$stage/receiver/backups" "$stage/receiver/locks" "$stage/receiver/state/idempotency" "$stage/receiver/state/gates"
chmod 0640 "$stage/.env" "$stage/receiver/.env" "$stage/tls/key.pem"
chmod 0644 "$stage/tls/cert.pem"
chown -R root:root "$stage"
chown -R nait-awg:nait-awg "$stage/data" "$stage/receiver/tmp" "$stage/receiver/backups" "$stage/receiver/locks" "$stage/receiver/state"
chown root:nait-awg "$stage/.env" "$stage/receiver/.env" "$stage/tls/key.pem"
chmod 0755 "$stage" "$stage/app" "$stage/receiver" "$stage/runtime" "$stage/tls"
[[ ! -e "$INSTALL_DIR" ]] || fail "$INSTALL_DIR appeared during installation; refusing to overwrite it."
mv -- "$stage" "$INSTALL_DIR"
stage=''
install -m 0644 "$SOURCE_DIR/deploy/nait-awg-selfhost.service" "/etc/systemd/system/$PANEL_UNIT"
install -m 0644 "$SOURCE_DIR/deploy/nait-awg-receiver-selfhost.service" "/etc/systemd/system/$RECEIVER_UNIT"
systemctl daemon-reload
note 'Запускаем внутренний сервис панели...'
systemctl --quiet enable --now "$RECEIVER_UNIT"
receiver_ready=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:42842/health >/dev/null; then
    receiver_ready=true
    break
  fi
  sleep 1
done
if [[ "$receiver_ready" != true ]]; then
  note 'Внутренний сервис не запустился. Последние сообщения:'
  journalctl -u "$RECEIVER_UNIT" -n 25 --no-pager >&2 || true
  fail "Проверьте состояние: sudo systemctl status $RECEIVER_UNIT"
fi
note 'Запускаем веб-панель...'
systemctl --quiet enable --now "$PANEL_UNIT"
panel_ready=false
for attempt in {1..20}; do
  if curl --insecure --fail --silent --max-time 2 "https://127.0.0.1:$panel_port/health" >/dev/null; then
    panel_ready=true
    break
  fi
  sleep 1
done
if [[ "$panel_ready" != true ]]; then
  note 'Панель не запустилась. Последние сообщения:'
  journalctl -u "$PANEL_UNIT" -n 25 --no-pager >&2 || true
  fail "Проверьте состояние: sudo systemctl status $PANEL_UNIT"
fi
[[ "$(docker inspect --format '{{.State.StartedAt}}' "$awg_container")" == "$awg_started_at" ]] || fail 'AWG container start time changed during installation; investigate immediately.'
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  note "Открываем TCP-порт $panel_port в UFW для веб-панели..."
  ufw allow "$panel_port/tcp" comment 'Nait-AWG web panel'
fi
note "Готово: https://$public_endpoint:$panel_port/ (самоподписанный сертификат)."
note 'VPN не перезапускали. Если панель недоступна, проверьте сетевой экран хостинга.'
