#!/usr/bin/env bash
# Download Nait-AWG when piped from GitHub, or install it from a local checkout.
# Add a panel to existing AWG 3.1 or bootstrap both components on a fresh VPS.
# Modes install/update never restart AWG. Mode full creates AWG only on a clean VPS.
set -Eeuo pipefail

if [[ "${1:-}" != install && "${1:-}" != full && "${1:-}" != update && "${1:-}" != audit && "${1:-}" != reset-auth ]]; then
  [[ $# -eq 0 ]] || { printf 'Использование: sudo bash install.sh [audit|install|full|update|reset-auth]\n' >&2; exit 2; }
  [[ "${EUID}" -eq 0 ]] || { printf 'Запустите через sudo.\n' >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { printf 'Нужен curl.\n' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { printf 'Нужен tar.\n' >&2; exit 1; }

  requested_action="${NAIT_AWG_ACTION:-}"
  if [[ -z "$requested_action" ]]; then
    [[ -r /dev/tty ]] || { printf 'Интерактивное меню недоступно. Укажите NAIT_AWG_ACTION=install, full, update или reset-auth.\n' >&2; exit 1; }
    printf '\nВыберите действие:\n' >&2
    printf '  1) Установить только веб-панель Nait-AWG\n' >&2
    printf '  2) Установить AmneziaWG 3.1 + веб-интерфейс Nait-AWG\n' >&2
    printf '  3) Обновить веб-интерфейс Nait-AWG\n' >&2
    printf '  4) Сбросить логин и пароль\n\n' >&2
    read -r -p 'Введите номер [1-4]: ' requested_action </dev/tty
    printf '\n\n' >&2
  fi
  case "$requested_action" in
    1|install) requested_action=install ;;
    2|full) requested_action=full ;;
    3|update) requested_action=update ;;
    4|reset-auth) requested_action=reset-auth ;;
    *) printf 'Неизвестный вариант. Выберите 1, 2, 3 или 4.\n' >&2; exit 2 ;;
  esac

  if [[ "$requested_action" == install && ( -e /opt/naitlab/nait_awg || -e /etc/systemd/system/nait-awg-selfhost.service ) ]]; then
    printf 'Nait-AWG уже установлен. Выберите пункт 3, чтобы обновить веб-панель.\n' >&2
    exit 1
  fi
  if [[ "$requested_action" == update && ! -d /opt/naitlab/nait_awg ]]; then
    printf 'Установка Nait-AWG не найдена. Сначала выберите пункт 1.\n' >&2
    exit 1
  fi
  if [[ "$requested_action" == reset-auth && ( ! -f /opt/naitlab/nait_awg/.env || ! -f /etc/systemd/system/nait-awg-selfhost.service ) ]]; then
    printf 'Установленная веб-панель Nait-AWG не найдена. Сброс отменён.\n' >&2
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

  if [[ "$requested_action" == update ]]; then
    printf 'Загружаем обновление Nait-AWG с GitHub...\n' >&2
  elif [[ "$requested_action" == reset-auth ]]; then
    printf 'Загружаем инструмент сброса доступа Nait-AWG...\n' >&2
  else
    printf 'Загружаем Nait-AWG с GitHub...\n' >&2
  fi
  curl --fail --location --retry 3 --silent --show-error \
    https://github.com/NaitSide/Nait-AWG/archive/refs/heads/main.tar.gz \
    -o "$download_stage/source.tar.gz"
  tar -xzf "$download_stage/source.tar.gz" -C "$download_stage"
  source_dir="$download_stage/Nait-AWG-main"
  [[ -f "$source_dir/install.sh" && -f "$source_dir/scripts/selfhost-preflight.js" && -f "$source_dir/scripts/admin-credentials.js" && -f "$source_dir/scripts/panel-access.js" ]] || {
    printf 'Архив проекта неполный. Установка отменена.\n' >&2
    exit 1
  }
  if [[ "$requested_action" != reset-auth ]]; then printf 'Проверяем совместимость сервера с AmneziaWG...\n' >&2; fi
  bash "$source_dir/install.sh" "$requested_action"
  exit 0
fi

readonly SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly INSTALL_DIR=/opt/naitlab/nait_awg
readonly PANEL_UNIT=nait-awg-selfhost.service
readonly RECEIVER_UNIT=nait-awg-receiver-selfhost.service
readonly DOMAIN_UNIT=nait-awg-domain.service
readonly NODE_ARCHIVE=node-v24.20.0-linux-x64.tar.xz
readonly NODE_SHA256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
stage=''
update_backup=''
update_active=false
update_committed=false
update_items=()
reset_backup=''
reset_auth_path=''
reset_had_auth=false
reset_snapshot_ready=false
reset_stopped=false
reset_committed=false
full_runtime_ready=false

fail() { printf 'Ошибка: %s\n' "$*" >&2; if declare -F installer_log_hint >/dev/null; then installer_log_hint; fi; exit 1; }
note() { printf '%s\n' "$*" >&2; }
rollback_reset() {
  [[ "$reset_stopped" == true && "$reset_committed" != true ]] || return 0
  note 'Сброс не завершился. Возвращаем прежние реквизиты панели...'
  if [[ "$reset_snapshot_ready" == true ]]; then
    mv -f -- "$reset_backup/panel.env" "$INSTALL_DIR/.env" || return 1
    if [[ "$reset_had_auth" == true ]]; then
      mv -f -- "$reset_backup/admin-auth" "$reset_auth_path" || return 1
    else
      rm -f -- "$reset_auth_path" || return 1
    fi
  fi
  systemctl restart "$PANEL_UNIT" || return 1
  reset_stopped=false
}
rollback_update() {
  [[ "$update_active" == true && "$update_committed" != true ]] || return 0
  set +e
  note 'Обновление не завершилось. Возвращаем предыдущую версию панели...'
  for item in "${update_items[@]}"; do
    mkdir -p -- "$update_backup/failed/$(dirname -- "$item")"
    if [[ -e "$INSTALL_DIR/$item" ]]; then mv -- "$INSTALL_DIR/$item" "$update_backup/failed/$item"; fi
    if [[ -e "$update_backup/old/$item" ]]; then
      mkdir -p -- "$INSTALL_DIR/$(dirname -- "$item")"
      mv -- "$update_backup/old/$item" "$INSTALL_DIR/$item"
    fi
  done
  if [[ -f "$update_backup/units/$PANEL_UNIT" ]]; then cp -a -- "$update_backup/units/$PANEL_UNIT" "/etc/systemd/system/$PANEL_UNIT"; fi
  if [[ -f "$update_backup/units/$RECEIVER_UNIT" ]]; then cp -a -- "$update_backup/units/$RECEIVER_UNIT" "/etc/systemd/system/$RECEIVER_UNIT"; fi
  if [[ -f "$update_backup/units/$DOMAIN_UNIT" ]]; then
    cp -a -- "$update_backup/units/$DOMAIN_UNIT" "/etc/systemd/system/$DOMAIN_UNIT"
  else
    systemctl disable --now "$DOMAIN_UNIT" >/dev/null 2>&1 || true
    rm -f -- "/etc/systemd/system/$DOMAIN_UNIT"
  fi
  systemctl daemon-reload
  if [[ -f "$update_backup/units/$DOMAIN_UNIT" ]]; then systemctl restart "$DOMAIN_UNIT"; fi
  systemctl restart "$RECEIVER_UNIT" "$PANEL_UNIT"
  note "Предыдущая версия возвращена. Диагностические файлы сохранены: $update_backup"
}
cleanup() {
  local install_exit_code=$?
  if ! rollback_reset; then
    note 'Не удалось вернуть прежние реквизиты. Веб-панель оставлена остановленной; проверьте службу и временную копию.'
    systemctl stop "$PANEL_UNIT" || true
  elif [[ "$reset_backup" == "$INSTALL_DIR"/.auth-reset.* && -d "$reset_backup" ]]; then
    rm -rf -- "$reset_backup"
  fi
  rollback_update
  if [[ "$stage" == /tmp/nait-awg.* && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  if [[ "$full_runtime_ready" == true && "$install_exit_code" -ne 0 ]]; then
    note 'AWG уже установлен. Его контейнер и ключи сохранены в /opt/naitlab/nait_awg_runtime.'
    if [[ ! -e "$INSTALL_DIR" ]]; then
      note 'После устранения ошибки выберите пункт 1 — установить панель на существующий AWG. Пункт 2 повторно не запускайте.'
    else
      note 'Панель установлена частично. Проверьте службы nait-awg-selfhost и nait-awg-receiver-selfhost; существующие файлы автоматически не заменяем.'
    fi
  fi
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || fail 'Run via sudo/root.'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'Only Linux x86_64 is supported.'
if [[ "${1:-}" == reset-auth ]]; then
  [[ -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/app/server.js" && -x "$INSTALL_DIR/runtime/bin/node" && -f "/etc/systemd/system/$PANEL_UNIT" ]] || fail 'Установленная веб-панель Nait-AWG не найдена или повреждена. Сброс отменён.'
  command -v systemctl >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || fail 'Для сброса нужны systemctl и curl.'
  [[ -f "$SOURCE_DIR/scripts/admin-credentials.js" && -f "$SOURCE_DIR/scripts/panel-access.js" ]] || fail 'Инструмент сброса доступа отсутствует в исходниках.'
  node="$INSTALL_DIR/runtime/bin/node"
  reset_info="$("$node" "$SOURCE_DIR/scripts/admin-credentials.js" inspect "$INSTALL_DIR")" || fail 'Не удалось проверить файлы авторизации. Ничего не изменено.'
  IFS=$'\t' read -r public_endpoint panel_port reset_auth_path <<< "$reset_info"
  note 'Сбрасываем доступ к панели. VPN и клиентов не трогаем...'
  reset_stopped=true
  systemctl stop "$PANEL_UNIT"
  reset_backup="$(mktemp -d "$INSTALL_DIR/.auth-reset.XXXXXX")"
  cp -a -- "$INSTALL_DIR/.env" "$reset_backup/panel.env"
  if [[ -f "$reset_auth_path" ]]; then
    cp -a -- "$reset_auth_path" "$reset_backup/admin-auth"
    reset_had_auth=true
  fi
  reset_snapshot_ready=true
  admin_password="$("$node" "$SOURCE_DIR/scripts/admin-credentials.js" reset "$INSTALL_DIR")" || fail 'Не удалось сбросить реквизиты.'
  systemctl restart "$PANEL_UNIT"
  panel_ready=false
  for attempt in {1..20}; do
    if curl --insecure --fail --silent --max-time 2 "https://127.0.0.1:$panel_port/health" >/dev/null; then
      panel_ready=true
      break
    fi
    sleep 1
  done
  [[ "$panel_ready" == true ]] || fail "Панель не запустилась после сброса. Проверьте: sudo systemctl status $PANEL_UNIT"
  panel_address="$("$node" "$SOURCE_DIR/scripts/panel-access.js" url "$public_endpoint" "$panel_port")" || fail 'Не удалось подготовить адрес панели.'
  reset_committed=true
  note "Доступ сброшен: $panel_address"
  note 'Логин: admin'
  note "Пароль: $admin_password"
  note '(Сохраните пароль и не забудьте сменить его в настройках.)'
  note 'Старые сеансы входа завершены. VPN, клиенты, порт и настройки сохранены.'
  exit 0
fi
[[ -r /etc/os-release ]] || fail 'Cannot identify the operating system.'
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail 'Only Ubuntu 24.04 is supported by this installer.'
if [[ "${1:-}" != audit ]]; then
  command -v flock >/dev/null 2>&1 || fail 'Для безопасной установки нужен flock (пакет util-linux).'
  exec 9>/run/nait-awg-install.lock
  flock -n 9 || fail 'Другой установщик Nait-AWG уже работает. Дождитесь его завершения.'
fi
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" && -f "$SOURCE_DIR/vendor/receiver/package-lock.json" && -f "$SOURCE_DIR/scripts/selfhost-preflight.js" && -f "$SOURCE_DIR/scripts/detect-public-ipv4.js" && -f "$SOURCE_DIR/scripts/admin-credentials.js" && -f "$SOURCE_DIR/scripts/panel-access.js" ]] || fail 'Run from a complete Nait-AWG source checkout.'
[[ -f "$SOURCE_DIR/scripts/installer-output.sh" ]] || fail 'В исходниках отсутствует модуль вывода установщика.'
source "$SOURCE_DIR/scripts/installer-output.sh"
if [[ "${1:-}" != audit ]]; then installer_log_init new; fi
if [[ "${1:-}" == full ]]; then
  [[ -f "$SOURCE_DIR/scripts/install-fresh-awg.sh" && -f "$SOURCE_DIR/scripts/start-fresh-awg.sh" && -f "$SOURCE_DIR/scripts/fresh-awg-config.js" && -f "$SOURCE_DIR/scripts/load-awg-image.sh" ]] || fail 'В исходниках отсутствует полный установщик AWG.'
  bash "$SOURCE_DIR/scripts/install-fresh-awg.sh" check
  note ''
  note '============================================================'
  note 'Установка AmneziaWG 3.1 + веб-интерфейс Nait-AWG'
  note ''
  note 'Используется официальный Docker-образ AmneziaWG 3.1'
  note 'от разработчиков Amnezia — тот же, который используется'
  note 'при установке через приложение AmneziaVPN.'
  note ''
  note 'Установщик настроит VPN на сервере и добавит'
  note 'веб-интерфейс для управления пользователями.'
  note 'Всё за один запуск, без предварительной установки'
  note 'через приложение.'
  note '============================================================'
  note ''
  if [[ -r /dev/tty ]]; then
    read -r -p 'Нажмите Enter, чтобы продолжить: ' confirmation </dev/tty || fail 'Продолжение не подтверждено. Установка отменена.'
  else
    [[ "${NAIT_AWG_ACCEPT_FRESH:-}" == 1 ]] || fail 'Для автоматической установки укажите NAIT_AWG_ACCEPT_FRESH=1.'
  fi
  bash "$SOURCE_DIR/scripts/install-fresh-awg.sh" prepare
fi
for command_name in docker curl openssl tar xz sha256sum systemctl ss getent useradd groupadd usermod; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Missing command: $command_name"
done
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" && -f "$SOURCE_DIR/vendor/receiver/package-lock.json" && -f "$SOURCE_DIR/scripts/selfhost-preflight.js" && -f "$SOURCE_DIR/scripts/detect-public-ipv4.js" && -f "$SOURCE_DIR/scripts/admin-credentials.js" && -f "$SOURCE_DIR/scripts/panel-access.js" ]] || fail 'Run from a complete Nait-AWG source checkout.'

if [[ "${1:-}" == install || "${1:-}" == full ]]; then
  [[ ! -e "$INSTALL_DIR" ]] || fail "Nait-AWG уже установлен: $INSTALL_DIR. Повторная установка остановлена; файлы не изменены."
  [[ ! -e "/etc/systemd/system/$PANEL_UNIT" && ! -e "/etc/systemd/system/$RECEIVER_UNIT" ]] || fail 'Обнаружены службы Nait-AWG. Повторная установка остановлена; проверьте существующую установку.'
  [[ -z "$(ss -H -ltn '( sport = :42842 )')" ]] || fail 'Внутренний TCP-порт 42842 уже занят. Проверьте, не установлен ли Nait-AWG.'
elif [[ "${1:-}" == update ]]; then
  [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/receiver/.env" ]] || fail 'Рабочая установка Nait-AWG не найдена или повреждена. Обновление остановлено.'
  [[ -f "/etc/systemd/system/$PANEL_UNIT" && -f "/etc/systemd/system/$RECEIVER_UNIT" ]] || fail 'Службы Nait-AWG не найдены. Обновление остановлено.'
elif [[ "${1:-}" != audit ]]; then
  printf 'Использование: sudo bash install.sh [audit|install|full|update|reset-auth]\n' >&2
  exit 2
fi

# The pinned Node archive may be supplied offline; otherwise fetch the official release.
note 'Проверяем настройки сервера...'
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

collect_install_options() {
  public_endpoint="${NAIT_AWG_PUBLIC_ENDPOINT:-}"
  if [[ -z "$public_endpoint" && -r /dev/tty ]]; then
    detected_endpoint="$("$node" "$SOURCE_DIR/scripts/detect-public-ipv4.js")"
    if [[ -n "$detected_endpoint" ]]; then
      read -r -p "Введите IPv4 сервера [$detected_endpoint]: " public_endpoint </dev/tty
      public_endpoint="${public_endpoint:-$detected_endpoint}"
    else
      read -r -p 'Введите IPv4 сервера: ' public_endpoint </dev/tty
    fi
  fi
  [[ "$public_endpoint" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'Set NAIT_AWG_PUBLIC_ENDPOINT to a public IPv4 address.'
  IFS=. read -r octet1 octet2 octet3 octet4 <<< "$public_endpoint"
  for octet in "$octet1" "$octet2" "$octet3" "$octet4"; do
    (( 10#$octet <= 255 )) || fail 'Invalid public IPv4 address.'
  done
  panel_port="${NAIT_AWG_PANEL_PORT:-}"
  local interactive_panel_port=false suggested_panel_port=443 normalized_port port_listeners
  if [[ -z "$panel_port" && -r /dev/tty ]]; then
    interactive_panel_port=true
    note '443 — доступ без указания порта в адресе, по IP или домену.'
    note 'Для другого порта рекомендуем свободное число от 20000 до 60000.'
    note 'Нажмите Enter для выбора предложенного порта или введите свой.'
  fi
  while true; do
    if [[ -z "$panel_port" ]]; then
      if [[ "$interactive_panel_port" == true ]]; then
        read -r -p "Порт веб-панели [$suggested_panel_port]: " panel_port </dev/tty || fail 'Выбор порта прерван.'
        panel_port="${panel_port:-$suggested_panel_port}"
      else
        panel_port=443
      fi
    fi
    if ! normalized_port="$("$node" "$SOURCE_DIR/scripts/panel-access.js" port "$panel_port" 2>/dev/null)"; then
      [[ "$interactive_panel_port" == true ]] || fail 'Выберите NAIT_AWG_PANEL_PORT=443 или порт от 1024 до 65535, кроме 42842.'
      note 'Выберите 443 или число от 1024 до 65535. Порт 42842 занят внутренним сервисом.'
      panel_port=''
      continue
    fi
    panel_port="$normalized_port"
    port_listeners="$(ss -H -ltn "( sport = :$panel_port )")" || fail 'Не удалось проверить занятость TCP-порта панели.'
    if [[ -z "$port_listeners" ]]; then break; fi
    [[ "$interactive_panel_port" == true ]] || fail "TCP-порт $panel_port занят. Укажите другой через NAIT_AWG_PANEL_PORT; чужие службы не остановлены."
    note "TCP-порт $panel_port занят другой программой. Выберите другой; чужие службы не трогаем."
    suggested_panel_port=''
    for attempt in {1..40}; do
      candidate_port="$("$node" -e 'process.stdout.write(String(require("node:crypto").randomInt(20000, 60001)))')"
      [[ "$candidate_port" != 42842 ]] || continue
      port_listeners="$(ss -H -ltn "( sport = :$candidate_port )")" || fail 'Не удалось проверить занятость TCP-портов.'
      if [[ -z "$port_listeners" ]]; then
        suggested_panel_port="$candidate_port"; break
      fi
    done
    [[ -n "$suggested_panel_port" ]] || fail 'Не удалось подобрать свободный порт для панели.'
    panel_port=''
  done
}
if [[ "${1:-}" == full ]]; then
  collect_install_options
  awg_port="${NAIT_AWG_VPN_PORT:-}"
  if [[ -z "$awg_port" ]]; then
    suggested_awg_port=55424
    for attempt in {1..40}; do
      if [[ -z "$(ss -H -lun "( sport = :$suggested_awg_port )")" ]]; then break; fi
      suggested_awg_port="$("$node" -e 'process.stdout.write(String(require("node:crypto").randomInt(20000, 60001)))')"
    done
    if [[ -r /dev/tty ]]; then
      read -r -p "Введите UDP-порт AmneziaWG [$suggested_awg_port]: " awg_port </dev/tty
      awg_port="${awg_port:-$suggested_awg_port}"
    else
      awg_port="$suggested_awg_port"
    fi
  fi
  bash "$SOURCE_DIR/scripts/install-fresh-awg.sh" install "$node" "$awg_port"
  full_runtime_ready=true
fi

note 'Ищем контейнер AmneziaWG и проверяем его настройки...'
IFS=$'\t' read -r awg_container awg_subnet awg_started_at < <("$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" --machine)
[[ "$awg_container" =~ ^amnezia-awg2?$ && "$awg_subnet" =~ ^[0-9./]+$ && "$awg_started_at" =~ ^[0-9TZ:.-]+$ ]] || fail 'Invalid preflight result.'
note "AmneziaWG 3.1 найден: $awg_container, $awg_subnet. Работающий VPN не трогаем."
if [[ "$awg_container" == amnezia-awg2 ]]; then
  note ''
  note '============================================================'
  note 'Разработчики Amnezia сохранили имя контейнера amnezia-awg2'
  note 'при переходе на AmneziaWG 3.1.'
  note 'Цифра 2 в имени не означает версию протокола.'
  note '============================================================'
  note ''
fi
if [[ "${1:-}" == audit ]]; then exit 0; fi

# The panel remains unprivileged. Standalone HTTP-01 needs no reverse proxy.
[[ -f "$SOURCE_DIR/app/domain-helper.js" && -f "$SOURCE_DIR/deploy/$DOMAIN_UNIT" ]] || fail 'В исходниках отсутствует служба сертификатов.'
if [[ ! -x /usr/bin/certbot ]]; then
  run_logged 'Подготавливаем выпуск сертификатов для домена...' env DEBIAN_FRONTEND=noninteractive apt-get update
  run_logged 'Устанавливаем службу сертификатов...' env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends certbot
fi

if [[ "${1:-}" == update ]]; then
  note 'Готовим обновление веб-панели. Пользователи, пароль и настройки будут сохранены...'
  install -d -m 0750 "$stage/receiver" "$stage/runtime"
  cp -R -- "$SOURCE_DIR/app" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$stage/"
  cp -R -- "$SOURCE_DIR/vendor/receiver/." "$stage/receiver/"
  cp -R -- "$stage/node-v24.20.0-linux-x64/." "$stage/runtime/"
  PATH="$stage/runtime/bin:$PATH" run_logged 'Устанавливаем библиотеки веб-панели...' "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
  PATH="$stage/runtime/bin:$PATH" run_logged 'Устанавливаем библиотеки внутреннего сервиса...' "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage/receiver" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
  rm -f -- "$stage/$NODE_ARCHIVE"
  rm -rf -- "$stage/node-v24.20.0-linux-x64"
  chown -R root:root "$stage/app" "$stage/runtime" "$stage/receiver" "$stage/package.json"
  chmod 0755 "$stage/app" "$stage/runtime" "$stage/receiver"

  update_backup="$(mktemp -d /opt/naitlab/.nait-awg-update.XXXXXX)"
  install -d -m 0700 "$update_backup/old" "$update_backup/units"
  cp -a -- "/etc/systemd/system/$PANEL_UNIT" "$update_backup/units/$PANEL_UNIT"
  cp -a -- "/etc/systemd/system/$RECEIVER_UNIT" "$update_backup/units/$RECEIVER_UNIT"
  if [[ -f "/etc/systemd/system/$DOMAIN_UNIT" ]]; then cp -a -- "/etc/systemd/system/$DOMAIN_UNIT" "$update_backup/units/$DOMAIN_UNIT"; fi
  update_candidates=(app runtime node_modules package.json package-lock.json receiver/src receiver/node_modules receiver/package.json receiver/package-lock.json receiver/README.md)
  update_items=()
  update_active=true
  systemctl stop "$DOMAIN_UNIT" >/dev/null 2>&1 || true
  for item in "${update_candidates[@]}"; do
    [[ -e "$stage/$item" ]] || continue
    update_items+=("$item")
    mkdir -p -- "$update_backup/old/$(dirname -- "$item")" "$INSTALL_DIR/$(dirname -- "$item")"
    if [[ -e "$INSTALL_DIR/$item" ]]; then mv -- "$INSTALL_DIR/$item" "$update_backup/old/$item"; fi
    mv -- "$stage/$item" "$INSTALL_DIR/$item"
  done
  node="$INSTALL_DIR/runtime/bin/node"
  install -m 0644 "$SOURCE_DIR/deploy/nait-awg-selfhost.service" "/etc/systemd/system/$PANEL_UNIT"
  install -m 0644 "$SOURCE_DIR/deploy/nait-awg-receiver-selfhost.service" "/etc/systemd/system/$RECEIVER_UNIT"
  install -m 0644 "$SOURCE_DIR/deploy/$DOMAIN_UNIT" "/etc/systemd/system/$DOMAIN_UNIT"
  systemctl daemon-reload
  systemctl --quiet enable --now "$DOMAIN_UNIT"

  note 'Перезапускаем внутренний сервис панели...'
  systemctl restart "$RECEIVER_UNIT"
  receiver_ready=false
  for attempt in {1..20}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:42842/health >/dev/null; then
      receiver_ready=true
      break
    fi
    sleep 1
  done
  [[ "$receiver_ready" == true ]] || fail "Внутренний сервис не запустился. Проверьте: sudo systemctl status $RECEIVER_UNIT"

  panel_port="$(sed -n 's/^PORT=//p' "$INSTALL_DIR/.env" | head -n 1)"
  public_endpoint="$(sed -n 's/^PUBLIC_ENDPOINT_HOST=//p' "$INSTALL_DIR/.env" | head -n 1)"
  [[ "$panel_port" =~ ^[0-9]{1,5}$ ]] || fail 'Не удалось прочитать порт существующей панели.'
  panel_address="$("$node" "$SOURCE_DIR/scripts/panel-access.js" url "$public_endpoint" "$panel_port")" || fail 'Не удалось подготовить адрес панели.'
  note 'Перезапускаем веб-панель...'
  systemctl restart "$PANEL_UNIT"
  panel_ready=false
  for attempt in {1..20}; do
    if curl --insecure --fail --silent --max-time 2 "https://127.0.0.1:$panel_port/health" >/dev/null; then
      panel_ready=true
      break
    fi
    sleep 1
  done
  [[ "$panel_ready" == true ]] || fail "Панель не запустилась. Проверьте: sudo systemctl status $PANEL_UNIT"
  [[ "$(docker inspect --format '{{.State.StartedAt}}' "$awg_container")" == "$awg_started_at" ]] || fail 'Контейнер AmneziaWG изменился во время обновления. Требуется проверка.'

  update_committed=true
  update_active=false
  rm -rf -- "$update_backup"
  update_backup=''
  note "Nait-AWG обновлён: $panel_address"
  note 'Пользователи, пароль, порт и настройки сохранены. Установщик обновил веб-интерфейс, не перезапуская контейнер AmneziaWG.'
  exit 0
fi

if [[ "${1:-}" != full ]]; then collect_install_options; fi
admin_password="$("$node" "$SOURCE_DIR/scripts/admin-credentials.js" generate)" || fail 'Не удалось сгенерировать пароль администратора.'

# Recheck before writing; a running VPN is not sufficient if its config/profile is stale.
"$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" >/dev/null
[[ "$(docker inspect --format '{{.State.StartedAt}}' "$awg_container")" == "$awg_started_at" ]] || fail 'AWG container restarted during preflight; retry later.'

note 'Устанавливаем панель. Контейнер VPN перезапускать не будем...'
install -d -m 0755 /opt/naitlab
install -d -m 0750 "$stage/receiver" "$stage/data" "$stage/tls" "$stage/runtime"
cp -R -- "$SOURCE_DIR/app" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$stage/"
cp -R -- "$SOURCE_DIR/vendor/receiver/." "$stage/receiver/"
cp -R -- "$stage/node-v24.20.0-linux-x64/." "$stage/runtime/"
PATH="$stage/runtime/bin:$PATH" run_logged 'Устанавливаем библиотеки веб-панели...' "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
PATH="$stage/runtime/bin:$PATH" run_logged 'Устанавливаем библиотеки внутреннего сервиса...' "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage/receiver" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
rm -f -- "$stage/$NODE_ARCHIVE"
rm -rf -- "$stage/node-v24.20.0-linux-x64"

if ! getent group nait-awg >/dev/null; then groupadd --system nait-awg; fi
if ! getent passwd nait-awg >/dev/null; then
  useradd --system --gid nait-awg --groups docker --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin nait-awg
fi
getent group docker | grep -qw nait-awg || usermod -aG docker nait-awg
nait_awg_gid="$(getent group nait-awg | cut -d: -f3)"

run_logged 'Создаём HTTPS-сертификат веб-панели...' openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout "$stage/tls/key.pem" -out "$stage/tls/cert.pem" \
  -subj "/CN=$public_endpoint" -addext "subjectAltName=IP:$public_endpoint"
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
NAIT_AWG_ADMIN_LOGIN=admin
NAIT_AWG_ADMIN_PASSWORD='$admin_password'
NAIT_AWG_AUTH_PATH=$INSTALL_DIR/data/admin-auth.json
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
node="$INSTALL_DIR/runtime/bin/node"
install -m 0644 "$SOURCE_DIR/deploy/nait-awg-selfhost.service" "/etc/systemd/system/$PANEL_UNIT"
install -m 0644 "$SOURCE_DIR/deploy/nait-awg-receiver-selfhost.service" "/etc/systemd/system/$RECEIVER_UNIT"
install -m 0644 "$SOURCE_DIR/deploy/$DOMAIN_UNIT" "/etc/systemd/system/$DOMAIN_UNIT"
systemctl daemon-reload
systemctl --quiet enable --now "$DOMAIN_UNIT"
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
  run_logged "Открываем TCP-порт $panel_port в UFW для веб-панели..." ufw allow "$panel_port/tcp" comment 'Nait-AWG web panel'
  run_logged 'Открываем TCP-порт 80 в UFW для проверки домена...' ufw allow '80/tcp' comment 'Nait-AWG domain validation'
fi
panel_address="$("$node" "$SOURCE_DIR/scripts/panel-access.js" url "$public_endpoint" "$panel_port")" || fail 'Не удалось подготовить адрес панели.'
note "Готово: $panel_address (самоподписанный сертификат)."
note 'Логин панели: admin'
note "Пароль: $admin_password"
note '(Сохраните пароль и не забудьте сменить его в настройках.)'
if [[ "${1:-}" == full ]]; then
  note "AmneziaWG 3.1 установлен и запущен: UDP-порт $awg_port. Выдайте первый доступ в веб-панели."
else
  note 'Установщик панели не перезапускал существующий контейнер AmneziaWG.'
fi
note 'Если подключение недоступно, проверьте TCP-порт панели и UDP-порт VPN в сетевом экране хостинга.'
note 'Для подключения домена разрешите у хостинга TCP-порт 80. Он нужен для выпуска и продления сертификата, не для входа в панель.'
