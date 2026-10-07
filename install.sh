#!/usr/bin/env bash
# Download Nait-AWG when piped from GitHub, or install it from a local checkout.
# Add a panel to existing AWG 3.1 or bootstrap both components on a fresh VPS.
# Modes install/update never restart AWG. Mode full creates AWG only on a clean VPS.
set -Eeuo pipefail

# BEGIN INSTALLER LANGUAGE
installer_text() {
  if [[ "${NAIT_AWG_LANG:-ru}" == en ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi
}

installer_language_init() {
  local language_choice="${NAIT_AWG_LANG:-}"
  if [[ -n "$language_choice" ]]; then
    case "$language_choice" in
      ru|en) export NAIT_AWG_LANG="$language_choice"; return 0 ;;
      *) printf 'NAIT_AWG_LANG: выберите ru или en / use ru or en.\n' >&2; return 2 ;;
    esac
  fi
  if ! { : </dev/tty; } 2>/dev/null; then
    # Preserve unattended installations; do not consume the piped script's stdin.
    export NAIT_AWG_LANG=ru
    return 0
  fi
  printf '\nВыберите язык / Select language:\n\n  1) RU\n  2) EN\n\n' >&2
  while true; do
    if ! read -r -p 'Введите номер / Enter number: ' language_choice </dev/tty; then
      printf '\nВыбор языка прерван / Language selection cancelled.\n' >&2
      return 1
    fi
    case "$language_choice" in
      1|ru|RU) export NAIT_AWG_LANG=ru; break ;;
      2|en|EN) export NAIT_AWG_LANG=en; break ;;
      *) printf 'Выберите 1 или 2 / Choose 1 or 2.\n' >&2 ;;
    esac
  done
  printf '\n' >&2
}
# END INSTALLER LANGUAGE
installer_language_init || exit $?


if [[ "${1:-}" != install && "${1:-}" != full && "${1:-}" != update && "${1:-}" != audit && "${1:-}" != reset-auth ]]; then
  [[ $# -eq 0 ]] || { printf "$(installer_text 'Использование: sudo bash install.sh [audit|install|full|update|reset-auth]\n' 'Usage: sudo bash install.sh [audit|install|full|update|reset-auth]\n')" >&2; exit 2; }
  [[ "${EUID}" -eq 0 ]] || { printf "$(installer_text 'Запустите через sudo.\n' 'Run with sudo.\n')" >&2; exit 1; }
  command -v curl >/dev/null 2>&1 || { printf "$(installer_text 'Нужен curl.\n' 'curl is required.\n')" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { printf "$(installer_text 'Нужен tar.\n' 'tar is required.\n')" >&2; exit 1; }

  requested_action="${NAIT_AWG_ACTION:-}"
  if [[ -z "$requested_action" ]]; then
    [[ -r /dev/tty ]] || { printf "$(installer_text 'Интерактивное меню недоступно. Укажите NAIT_AWG_ACTION=install, full, update или reset-auth.\n' 'Interactive menu is unavailable. Set NAIT_AWG_ACTION=install, full, update or reset-auth.\n')" >&2; exit 1; }
    printf "$(installer_text '\nВыберите действие:\n' '\nChoose an action:\n')" >&2
    printf "$(installer_text '  1) Установить только веб-панель Nait-AWG\n' '  1) Install the Nait-AWG web panel only\n')" >&2
    printf "$(installer_text '  2) Установить AmneziaWG 3.1 + веб-интерфейс Nait-AWG\n' '  2) Install AmneziaWG 3.1 + the Nait-AWG web panel\n')" >&2
    printf "$(installer_text '  3) Обновить веб-интерфейс Nait-AWG\n' '  3) Update the Nait-AWG web panel\n')" >&2
    printf "$(installer_text '  4) Сбросить логин и пароль\n\n' '  4) Reset username and password\n\n')" >&2
    read -r -p "$(installer_text 'Введите номер [1-4]: ' 'Enter number [1-4]: ')" requested_action </dev/tty
    printf '\n\n' >&2
  fi
  case "$requested_action" in
    1|install) requested_action=install ;;
    2|full) requested_action=full ;;
    3|update) requested_action=update ;;
    4|reset-auth) requested_action=reset-auth ;;
    *) printf "$(installer_text 'Неизвестный вариант. Выберите 1, 2, 3 или 4.\n' 'Unknown option. Choose 1, 2, 3 or 4.\n')" >&2; exit 2 ;;
  esac

  if [[ "$requested_action" == install && ( -e /opt/naitlab/nait_awg || -e /etc/systemd/system/nait-awg-selfhost.service ) ]]; then
    printf "$(installer_text 'Nait-AWG уже установлен. Выберите пункт 3, чтобы обновить веб-панель.\n' 'Nait-AWG is already installed. Choose option 3 to update the web panel.\n')" >&2
    exit 1
  fi
  if [[ "$requested_action" == update && ! -d /opt/naitlab/nait_awg ]]; then
    printf "$(installer_text 'Установка Nait-AWG не найдена. Сначала выберите пункт 1.\n' 'Nait-AWG installation not found. Choose option 1 first.\n')" >&2
    exit 1
  fi
  if [[ "$requested_action" == reset-auth && ( ! -f /opt/naitlab/nait_awg/.env || ! -f /etc/systemd/system/nait-awg-selfhost.service ) ]]; then
    printf "$(installer_text 'Установленная веб-панель Nait-AWG не найдена. Сброс отменён.\n' 'Installed Nait-AWG web panel not found. Reset cancelled.\n')" >&2
    exit 1
  fi

  if command -v hostname >/dev/null 2>&1 && command -v getent >/dev/null 2>&1; then
    server_name="$(hostname)"
    if [[ -n "$server_name" ]] && ! getent hosts "$server_name" >/dev/null; then
      printf "$(installer_text 'Имя сервера %s не находится в /etc/hosts. Это вызывает предупреждение sudo; инструкция есть в README.\n' 'Server hostname %s is missing from /etc/hosts. This causes a sudo warning; see README for instructions.\n')" "$server_name" >&2
    fi
  fi

  download_stage="$(mktemp -d /tmp/nait-awg-download.XXXXXX)"
  cleanup_download() { if [[ "$download_stage" == /tmp/nait-awg-download.* && -d "$download_stage" ]]; then rm -rf -- "$download_stage"; fi; }
  trap cleanup_download EXIT

  if [[ "$requested_action" == update ]]; then
    printf "$(installer_text 'Загружаем обновление Nait-AWG с GitHub...\n' 'Downloading the Nait-AWG update from GitHub...\n')" >&2
  elif [[ "$requested_action" == reset-auth ]]; then
    printf "$(installer_text 'Загружаем инструмент сброса доступа Nait-AWG...\n' 'Downloading the Nait-AWG access reset tool...\n')" >&2
  else
    printf "$(installer_text 'Загружаем Nait-AWG с GitHub...\n' 'Downloading Nait-AWG from GitHub...\n')" >&2
  fi
  curl --fail --location --retry 3 --silent --show-error \
    https://github.com/NaitSide/Nait-AWG/archive/refs/heads/main.tar.gz \
    -o "$download_stage/source.tar.gz"
  tar -xzf "$download_stage/source.tar.gz" -C "$download_stage"
  source_dir="$download_stage/Nait-AWG-main"
  [[ -f "$source_dir/scripts/installer-language.sh" && -f "$source_dir/scripts/installer-i18n.js" && -f "$source_dir/install.sh" && -f "$source_dir/scripts/selfhost-preflight.js" && -f "$source_dir/scripts/admin-credentials.js" && -f "$source_dir/scripts/panel-access.js" ]] || {
    printf "$(installer_text 'Архив проекта неполный. Установка отменена.\n' 'Project archive is incomplete. Installation cancelled.\n')" >&2
    exit 1
  }
  if [[ "$requested_action" != reset-auth ]]; then printf "$(installer_text 'Проверяем совместимость сервера с AmneziaWG...\n' 'Checking server compatibility with AmneziaWG...\n')" >&2; fi
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

fail() { printf "$(installer_text 'Ошибка: %s\n' 'Error: %s\n')" "$*" >&2; if declare -F installer_log_hint >/dev/null; then installer_log_hint; fi; exit 1; }
note() { printf '%s\n' "$*" >&2; }
rollback_reset() {
  [[ "$reset_stopped" == true && "$reset_committed" != true ]] || return 0
  note "$(installer_text 'Сброс не завершился. Возвращаем прежние реквизиты панели...' 'Reset did not finish. Restoring the previous panel credentials...')"
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
  note "$(installer_text 'Обновление не завершилось. Возвращаем предыдущую версию панели...' 'Update did not finish. Restoring the previous panel version...')"
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
  note "$(installer_text "Предыдущая версия возвращена. Диагностические файлы сохранены: $update_backup" "Previous version restored. Diagnostic files saved: $update_backup")"
}
cleanup() {
  local install_exit_code=$?
  if ! rollback_reset; then
    note "$(installer_text 'Не удалось вернуть прежние реквизиты. Веб-панель оставлена остановленной; проверьте службу и временную копию.' 'Could not restore the previous credentials. The web panel remains stopped; check the service and temporary backup.')"
    systemctl stop "$PANEL_UNIT" || true
  elif [[ "$reset_backup" == "$INSTALL_DIR"/.auth-reset.* && -d "$reset_backup" ]]; then
    rm -rf -- "$reset_backup"
  fi
  rollback_update
  if [[ "$stage" == /tmp/nait-awg.* && -d "$stage" ]]; then rm -rf -- "$stage"; fi
  if [[ "$full_runtime_ready" == true && "$install_exit_code" -ne 0 ]]; then
    note "$(installer_text 'AWG уже установлен. Его контейнер и ключи сохранены в /opt/naitlab/nait_awg_runtime.' 'AWG is already installed. Its container and keys are preserved in /opt/naitlab/nait_awg_runtime.')"
    if [[ ! -e "$INSTALL_DIR" ]]; then
      note "$(installer_text 'После устранения ошибки выберите пункт 1 — установить панель на существующий AWG. Пункт 2 повторно не запускайте.' 'After resolving the error, choose option 1 to install the panel on the existing AWG. Do not run option 2 again.')"
    else
      note "$(installer_text 'Панель установлена частично. Проверьте службы nait-awg-selfhost и nait-awg-receiver-selfhost; существующие файлы автоматически не заменяем.' 'The panel is partially installed. Check nait-awg-selfhost and nait-awg-receiver-selfhost services; existing files will not be replaced automatically.')"
    fi
  fi
}
trap cleanup EXIT

[[ "${EUID}" -eq 0 ]] || fail "$(installer_text 'Запустите через sudo или от имени root.' 'Run via sudo/root.')"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail "$(installer_text 'Поддерживается только Linux x86_64.' 'Only Linux x86_64 is supported.')"
if [[ "${1:-}" == reset-auth ]]; then
  [[ -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/app/server.js" && -x "$INSTALL_DIR/runtime/bin/node" && -f "/etc/systemd/system/$PANEL_UNIT" ]] || fail "$(installer_text 'Установленная веб-панель Nait-AWG не найдена или повреждена. Сброс отменён.' 'Installed Nait-AWG web panel not found or damaged. Reset cancelled.')"
  command -v systemctl >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || fail "$(installer_text 'Для сброса нужны systemctl и curl.' 'systemctl and curl are required to reset access.')"
  [[ -f "$SOURCE_DIR/scripts/installer-i18n.js" && -f "$SOURCE_DIR/scripts/admin-credentials.js" && -f "$SOURCE_DIR/scripts/panel-access.js" ]] || fail "$(installer_text 'Инструмент сброса доступа отсутствует в исходниках.' 'Access reset tool is missing from the source files.')"
  node="$INSTALL_DIR/runtime/bin/node"
  reset_info="$("$node" "$SOURCE_DIR/scripts/admin-credentials.js" inspect "$INSTALL_DIR")" || fail "$(installer_text 'Не удалось проверить файлы авторизации. Ничего не изменено.' 'Could not verify authentication files. Nothing was changed.')"
  IFS=$'\t' read -r public_endpoint panel_port reset_auth_path <<< "$reset_info"
  note "$(installer_text 'Сбрасываем доступ к панели. VPN и клиентов не трогаем...' 'Resetting panel access. VPN and clients will not be changed...')"
  reset_stopped=true
  systemctl stop "$PANEL_UNIT"
  reset_backup="$(mktemp -d "$INSTALL_DIR/.auth-reset.XXXXXX")"
  cp -a -- "$INSTALL_DIR/.env" "$reset_backup/panel.env"
  if [[ -f "$reset_auth_path" ]]; then
    cp -a -- "$reset_auth_path" "$reset_backup/admin-auth"
    reset_had_auth=true
  fi
  reset_snapshot_ready=true
  admin_password="$("$node" "$SOURCE_DIR/scripts/admin-credentials.js" reset "$INSTALL_DIR")" || fail "$(installer_text 'Не удалось сбросить реквизиты.' 'Could not reset the credentials.')"
  systemctl restart "$PANEL_UNIT"
  panel_ready=false
  for attempt in {1..20}; do
    if curl --insecure --fail --silent --max-time 2 "https://127.0.0.1:$panel_port/health" >/dev/null; then
      panel_ready=true
      break
    fi
    sleep 1
  done
  [[ "$panel_ready" == true ]] || fail "$(installer_text "Панель не запустилась после сброса. Проверьте: sudo systemctl status $PANEL_UNIT" "Panel did not start after the reset. Check: sudo systemctl status $PANEL_UNIT")"
  panel_address="$("$node" "$SOURCE_DIR/scripts/panel-access.js" url "$public_endpoint" "$panel_port")" || fail "$(installer_text 'Не удалось подготовить адрес панели.' 'Could not prepare the panel address.')"
  reset_committed=true
  note "$(installer_text "Доступ сброшен: $panel_address" "Access reset: $panel_address")"
  note "$(installer_text 'Логин: admin' 'Username: admin')"
  note "$(installer_text "Пароль: $admin_password" "Password: $admin_password")"
  note "$(installer_text '(Сохраните пароль и не забудьте сменить его в настройках.)' '(Save the password and remember to change it in settings.)')"
  note "$(installer_text 'Старые сеансы входа завершены. VPN, клиенты, порт и настройки сохранены.' 'Previous login sessions have ended. VPN, clients, port and settings are preserved.')"
  exit 0
fi
[[ -r /etc/os-release ]] || fail "$(installer_text 'Не удалось определить операционную систему.' 'Cannot identify the operating system.')"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail "$(installer_text 'Установщик поддерживает только Ubuntu 24.04.' 'Only Ubuntu 24.04 is supported by this installer.')"
if [[ "${1:-}" != audit ]]; then
  command -v flock >/dev/null 2>&1 || fail "$(installer_text 'Для безопасной установки нужен flock (пакет util-linux).' 'flock (util-linux package) is required for safe installation.')"
  exec 9>/run/nait-awg-install.lock
  flock -n 9 || fail "$(installer_text 'Другой установщик Nait-AWG уже работает. Дождитесь его завершения.' 'Another Nait-AWG installer is running. Wait for it to finish.')"
fi
[[ -f "$SOURCE_DIR/scripts/installer-language.sh" && -f "$SOURCE_DIR/scripts/installer-i18n.js" && -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" && -f "$SOURCE_DIR/vendor/receiver/package-lock.json" && -f "$SOURCE_DIR/scripts/selfhost-preflight.js" && -f "$SOURCE_DIR/scripts/detect-public-ipv4.js" && -f "$SOURCE_DIR/scripts/admin-credentials.js" && -f "$SOURCE_DIR/scripts/panel-access.js" ]] || fail "$(installer_text 'Запустите из полного каталога исходников Nait-AWG.' 'Run from a complete Nait-AWG source checkout.')"
[[ -f "$SOURCE_DIR/scripts/installer-output.sh" ]] || fail "$(installer_text 'В исходниках отсутствует модуль вывода установщика.' 'Installer output module is missing from the source files.')"
source "$SOURCE_DIR/scripts/installer-output.sh"
if [[ "${1:-}" != audit ]]; then installer_log_init new; fi
if [[ "${1:-}" == full ]]; then
  [[ -f "$SOURCE_DIR/scripts/install-fresh-awg.sh" && -f "$SOURCE_DIR/scripts/start-fresh-awg.sh" && -f "$SOURCE_DIR/scripts/fresh-awg-config.js" && -f "$SOURCE_DIR/scripts/load-awg-image.sh" ]] || fail "$(installer_text 'В исходниках отсутствует полный установщик AWG.' 'Complete AWG installer is missing from the source files.')"
  bash "$SOURCE_DIR/scripts/install-fresh-awg.sh" check
  note ''
  note '============================================================'
  note "$(installer_text 'Установка AmneziaWG 3.1 + веб-интерфейс Nait-AWG' 'Installing AmneziaWG 3.1 + the Nait-AWG web panel')"
  note ''
  note "$(installer_text 'Используется официальный Docker-образ AmneziaWG 3.1' 'This uses the official AmneziaWG 3.1 Docker image')"
  note "$(installer_text 'от разработчиков Amnezia — тот же, который используется' 'from the Amnezia developers, the same image used')"
  note "$(installer_text 'при установке через приложение AmneziaVPN.' 'when installing through the AmneziaVPN application.')"
  note ''
  note "$(installer_text 'Установщик настроит VPN на сервере и добавит' 'The installer will configure VPN on the server and add')"
  note "$(installer_text 'веб-интерфейс для управления пользователями.' 'a web interface for managing clients.')"
  note "$(installer_text 'Всё за один запуск, без предварительной установки' 'All in one run, without a separate installation')"
  note "$(installer_text 'через приложение.' 'through the application.')"
  note '============================================================'
  note ''
  if [[ -r /dev/tty ]]; then
    read -r -p "$(installer_text 'Нажмите Enter, чтобы продолжить: ' 'Press Enter to continue: ')" confirmation </dev/tty || fail "$(installer_text 'Продолжение не подтверждено. Установка отменена.' 'Continuation was not confirmed. Installation cancelled.')"
  else
    [[ "${NAIT_AWG_ACCEPT_FRESH:-}" == 1 ]] || fail "$(installer_text 'Для автоматической установки укажите NAIT_AWG_ACCEPT_FRESH=1.' 'For unattended installation, set NAIT_AWG_ACCEPT_FRESH=1.')"
  fi
  bash "$SOURCE_DIR/scripts/install-fresh-awg.sh" prepare
fi
for command_name in docker curl openssl tar xz sha256sum systemctl ss getent useradd groupadd usermod; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$(installer_text "Не найдена команда: $command_name" "Missing command: $command_name")"
done
[[ -f "$SOURCE_DIR/scripts/installer-language.sh" && -f "$SOURCE_DIR/scripts/installer-i18n.js" && -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" && -f "$SOURCE_DIR/vendor/receiver/package-lock.json" && -f "$SOURCE_DIR/scripts/selfhost-preflight.js" && -f "$SOURCE_DIR/scripts/detect-public-ipv4.js" && -f "$SOURCE_DIR/scripts/admin-credentials.js" && -f "$SOURCE_DIR/scripts/panel-access.js" ]] || fail "$(installer_text 'Запустите из полного каталога исходников Nait-AWG.' 'Run from a complete Nait-AWG source checkout.')"

if [[ "${1:-}" == install || "${1:-}" == full ]]; then
  [[ ! -e "$INSTALL_DIR" ]] || fail "$(installer_text "Nait-AWG уже установлен: $INSTALL_DIR. Повторная установка остановлена; файлы не изменены." "Nait-AWG is already installed: $INSTALL_DIR. Reinstallation stopped; files were not changed.")"
  [[ ! -e "/etc/systemd/system/$PANEL_UNIT" && ! -e "/etc/systemd/system/$RECEIVER_UNIT" ]] || fail "$(installer_text 'Обнаружены службы Nait-AWG. Повторная установка остановлена; проверьте существующую установку.' 'Nait-AWG services detected. Reinstallation stopped; check the existing installation.')"
  [[ -z "$(ss -H -ltn '( sport = :42842 )')" ]] || fail "$(installer_text 'Внутренний TCP-порт 42842 уже занят. Проверьте, не установлен ли Nait-AWG.' 'Internal TCP port 42842 is already in use. Check whether Nait-AWG is installed.')"
elif [[ "${1:-}" == update ]]; then
  [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/receiver/.env" ]] || fail "$(installer_text 'Рабочая установка Nait-AWG не найдена или повреждена. Обновление остановлено.' 'Working Nait-AWG installation not found or damaged. Update stopped.')"
  [[ -f "/etc/systemd/system/$PANEL_UNIT" && -f "/etc/systemd/system/$RECEIVER_UNIT" ]] || fail "$(installer_text 'Службы Nait-AWG не найдены. Обновление остановлено.' 'Nait-AWG services not found. Update stopped.')"
elif [[ "${1:-}" != audit ]]; then
  printf "$(installer_text 'Использование: sudo bash install.sh [audit|install|full|update|reset-auth]\n' 'Usage: sudo bash install.sh [audit|install|full|update|reset-auth]\n')" >&2
  exit 2
fi

# The pinned Node archive may be supplied offline; otherwise fetch the official release.
note "$(installer_text 'Проверяем настройки сервера...' 'Checking server settings...')"
stage="$(mktemp -d /tmp/nait-awg.XXXXXX)"
if [[ -n "${NAIT_AWG_NODE_ARCHIVE:-}" ]]; then
  [[ -f "$NAIT_AWG_NODE_ARCHIVE" ]] || fail "$(installer_text 'NAIT_AWG_NODE_ARCHIVE должен указывать на доступный файл.' 'NAIT_AWG_NODE_ARCHIVE is not a readable file.')"
  cp -- "$NAIT_AWG_NODE_ARCHIVE" "$stage/$NODE_ARCHIVE"
else
  curl --fail --location --retry 3 --silent --show-error \
    "https://nodejs.org/dist/v24.20.0/$NODE_ARCHIVE" -o "$stage/$NODE_ARCHIVE"
fi
printf '%s  %s\n' "$NODE_SHA256" "$stage/$NODE_ARCHIVE" | sha256sum --check --status || fail "$(installer_text 'Контрольная сумма архива Node.js не совпала.' 'Node archive checksum mismatch.')"
tar -xJf "$stage/$NODE_ARCHIVE" -C "$stage"
node="$stage/node-v24.20.0-linux-x64/bin/node"
npm="$stage/node-v24.20.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js"
[[ -x "$node" && -f "$npm" ]] || fail "$(installer_text 'Архив Node.js неполный.' 'Node archive is incomplete.')"

collect_install_options() {
  public_endpoint="${NAIT_AWG_PUBLIC_ENDPOINT:-}"
  if [[ -z "$public_endpoint" && -r /dev/tty ]]; then
    detected_endpoint="$("$node" "$SOURCE_DIR/scripts/detect-public-ipv4.js")"
    if [[ -n "$detected_endpoint" ]]; then
      read -r -p "$(installer_text "Введите IPv4 сервера [$detected_endpoint]: " "Enter server IPv4 [$detected_endpoint]: ")" public_endpoint </dev/tty
      public_endpoint="${public_endpoint:-$detected_endpoint}"
    else
      read -r -p "$(installer_text 'Введите IPv4 сервера: ' 'Enter server IPv4: ')" public_endpoint </dev/tty
    fi
  fi
  [[ "$public_endpoint" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail "$(installer_text 'Укажите публичный IPv4 сервера в NAIT_AWG_PUBLIC_ENDPOINT.' 'Set NAIT_AWG_PUBLIC_ENDPOINT to a public IPv4 address.')"
  IFS=. read -r octet1 octet2 octet3 octet4 <<< "$public_endpoint"
  for octet in "$octet1" "$octet2" "$octet3" "$octet4"; do
    (( 10#$octet <= 255 )) || fail "$(installer_text 'Некорректный публичный IPv4.' 'Invalid public IPv4 address.')"
  done
  panel_port="${NAIT_AWG_PANEL_PORT:-}"
  local interactive_panel_port=false suggested_panel_port=443 normalized_port port_listeners
  if [[ -z "$panel_port" && -r /dev/tty ]]; then
    interactive_panel_port=true
    note "$(installer_text '443 — доступ без указания порта в адресе, по IP или домену.' '443 provides access by IP or domain without a port number in the address.')"
    note "$(installer_text 'Для другого порта рекомендуем свободное число от 20000 до 60000.' 'For another port, we recommend a free number from 20000 to 60000.')"
    note "$(installer_text 'Нажмите Enter для выбора предложенного порта или введите свой.' 'Press Enter to use the suggested port or enter your own.')"
  fi
  while true; do
    if [[ -z "$panel_port" ]]; then
      if [[ "$interactive_panel_port" == true ]]; then
        read -r -p "$(installer_text "Порт веб-панели [$suggested_panel_port]: " "Web panel port [$suggested_panel_port]: ")" panel_port </dev/tty || fail "$(installer_text 'Выбор порта прерван.' 'Port selection cancelled.')"
        panel_port="${panel_port:-$suggested_panel_port}"
      else
        panel_port=443
      fi
    fi
    if ! normalized_port="$("$node" "$SOURCE_DIR/scripts/panel-access.js" port "$panel_port" 2>/dev/null)"; then
      [[ "$interactive_panel_port" == true ]] || fail "$(installer_text 'Выберите NAIT_AWG_PANEL_PORT=443 или порт от 1024 до 65535, кроме 42842.' 'Set NAIT_AWG_PANEL_PORT=443 or a port from 1024 to 65535, excluding 42842.')"
      note "$(installer_text 'Выберите 443 или число от 1024 до 65535. Порт 42842 занят внутренним сервисом.' 'Choose 443 or a number from 1024 to 65535. Port 42842 is used by the internal service.')"
      panel_port=''
      continue
    fi
    panel_port="$normalized_port"
    port_listeners="$(ss -H -ltn "( sport = :$panel_port )")" || fail "$(installer_text 'Не удалось проверить занятость TCP-порта панели.' 'Could not check whether the panel TCP port is in use.')"
    if [[ -z "$port_listeners" ]]; then break; fi
    [[ "$interactive_panel_port" == true ]] || fail "$(installer_text "TCP-порт $panel_port занят. Укажите другой через NAIT_AWG_PANEL_PORT; чужие службы не остановлены." "TCP port $panel_port is in use. Set another via NAIT_AWG_PANEL_PORT; other services were not stopped.")"
    note "$(installer_text "TCP-порт $panel_port занят другой программой. Выберите другой; чужие службы не трогаем." "TCP port $panel_port is used by another program. Choose another; other services will not be changed.")"
    suggested_panel_port=''
    for attempt in {1..40}; do
      candidate_port="$("$node" -e 'process.stdout.write(String(require("node:crypto").randomInt(20000, 60001)))')"
      [[ "$candidate_port" != 42842 ]] || continue
      port_listeners="$(ss -H -ltn "( sport = :$candidate_port )")" || fail "$(installer_text 'Не удалось проверить занятость TCP-портов.' 'Could not check whether TCP ports are in use.')"
      if [[ -z "$port_listeners" ]]; then
        suggested_panel_port="$candidate_port"; break
      fi
    done
    [[ -n "$suggested_panel_port" ]] || fail "$(installer_text 'Не удалось подобрать свободный порт для панели.' 'Could not find a free port for the panel.')"
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
      read -r -p "$(installer_text "Введите UDP-порт AmneziaWG [$suggested_awg_port]: " "Enter AmneziaWG UDP port [$suggested_awg_port]: ")" awg_port </dev/tty
      awg_port="${awg_port:-$suggested_awg_port}"
    else
      awg_port="$suggested_awg_port"
    fi
  fi
  bash "$SOURCE_DIR/scripts/install-fresh-awg.sh" install "$node" "$awg_port"
  full_runtime_ready=true
fi

note "$(installer_text 'Ищем контейнер AmneziaWG и проверяем его настройки...' 'Finding the AmneziaWG container and checking its settings...')"
IFS=$'\t' read -r awg_container awg_subnet awg_started_at < <("$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" --machine)
[[ "$awg_container" =~ ^amnezia-awg2?$ && "$awg_subnet" =~ ^[0-9./]+$ && "$awg_started_at" =~ ^[0-9TZ:.-]+$ ]] || fail "$(installer_text 'Некорректный результат проверки совместимости.' 'Invalid preflight result.')"
note "$(installer_text "AmneziaWG 3.1 найден: $awg_container, $awg_subnet. Работающий VPN не трогаем." "AmneziaWG 3.1 found: $awg_container, $awg_subnet. The running VPN will not be changed.")"
if [[ "$awg_container" == amnezia-awg2 ]]; then
  note ''
  note '============================================================'
  note "$(installer_text 'Разработчики Amnezia сохранили имя контейнера amnezia-awg2' 'The Amnezia developers kept the amnezia-awg2 container name')"
  note "$(installer_text 'при переходе на AmneziaWG 3.1.' 'when moving to AmneziaWG 3.1.')"
  note "$(installer_text 'Цифра 2 в имени не означает версию протокола.' 'The number 2 in the name does not indicate the protocol version.')"
  note '============================================================'
  note ''
fi
if [[ "${1:-}" == audit ]]; then exit 0; fi

# The panel remains unprivileged. Standalone HTTP-01 needs no reverse proxy.
[[ -f "$SOURCE_DIR/app/domain-helper.js" && -f "$SOURCE_DIR/deploy/$DOMAIN_UNIT" ]] || fail "$(installer_text 'В исходниках отсутствует служба сертификатов.' 'Certificate service is missing from the source files.')"
if [[ ! -x /usr/bin/certbot ]]; then
  run_logged "$(installer_text 'Подготавливаем выпуск сертификатов для домена...' 'Preparing certificate issuance for the domain...')" env DEBIAN_FRONTEND=noninteractive apt-get update
  run_logged "$(installer_text 'Устанавливаем службу сертификатов...' 'Installing the certificate service...')" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends certbot
fi

if [[ "${1:-}" == update ]]; then
  note "$(installer_text 'Готовим обновление веб-панели. Пользователи, пароль и настройки будут сохранены...' 'Preparing the web panel update. Clients, password and settings will be preserved...')"
  install -d -m 0750 "$stage/receiver" "$stage/runtime"
  cp -R -- "$SOURCE_DIR/app" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$stage/"
  cp -R -- "$SOURCE_DIR/vendor/receiver/." "$stage/receiver/"
  cp -R -- "$stage/node-v24.20.0-linux-x64/." "$stage/runtime/"
  PATH="$stage/runtime/bin:$PATH" run_logged "$(installer_text 'Устанавливаем библиотеки веб-панели...' 'Installing web panel dependencies...')" "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
  PATH="$stage/runtime/bin:$PATH" run_logged "$(installer_text 'Устанавливаем библиотеки внутреннего сервиса...' 'Installing internal service dependencies...')" "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage/receiver" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
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

  note "$(installer_text 'Перезапускаем внутренний сервис панели...' 'Restarting the internal panel service...')"
  systemctl restart "$RECEIVER_UNIT"
  receiver_ready=false
  for attempt in {1..20}; do
    if curl --fail --silent --max-time 2 http://127.0.0.1:42842/health >/dev/null; then
      receiver_ready=true
      break
    fi
    sleep 1
  done
  [[ "$receiver_ready" == true ]] || fail "$(installer_text "Внутренний сервис не запустился. Проверьте: sudo systemctl status $RECEIVER_UNIT" "Internal service did not start. Check: sudo systemctl status $RECEIVER_UNIT")"

  panel_port="$(sed -n 's/^PORT=//p' "$INSTALL_DIR/.env" | head -n 1)"
  public_endpoint="$(sed -n 's/^PUBLIC_ENDPOINT_HOST=//p' "$INSTALL_DIR/.env" | head -n 1)"
  [[ "$panel_port" =~ ^[0-9]{1,5}$ ]] || fail "$(installer_text 'Не удалось прочитать порт существующей панели.' 'Could not read the existing panel port.')"
  panel_address="$("$node" "$SOURCE_DIR/scripts/panel-access.js" url "$public_endpoint" "$panel_port")" || fail "$(installer_text 'Не удалось подготовить адрес панели.' 'Could not prepare the panel address.')"
  note "$(installer_text 'Перезапускаем веб-панель...' 'Restarting the web panel...')"
  systemctl restart "$PANEL_UNIT"
  panel_ready=false
  for attempt in {1..20}; do
    if curl --insecure --fail --silent --max-time 2 "https://127.0.0.1:$panel_port/health" >/dev/null; then
      panel_ready=true
      break
    fi
    sleep 1
  done
  [[ "$panel_ready" == true ]] || fail "$(installer_text "Панель не запустилась. Проверьте: sudo systemctl status $PANEL_UNIT" "Panel did not start. Check: sudo systemctl status $PANEL_UNIT")"
  panel_address="$("$node" "$SOURCE_DIR/scripts/panel-access.js" installed-url "$public_endpoint" "$panel_port")" || fail "$(installer_text 'Не удалось подготовить адрес панели.' 'Could not prepare the panel address.')"
  [[ "$(docker inspect --format '{{.State.StartedAt}}' "$awg_container")" == "$awg_started_at" ]] || fail "$(installer_text 'Контейнер AmneziaWG изменился во время обновления. Требуется проверка.' 'AmneziaWG container changed during the update. Verification is required.')"

  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    run_logged "$(installer_text 'Открываем TCP-порт 80 в UFW для сертификатов домена...' 'Opening TCP port 80 in UFW for domain certificates...')" ufw allow '80/tcp' comment 'Nait-AWG certificates'
  fi
  update_committed=true
  update_active=false
  rm -rf -- "$update_backup"
  update_backup=''
  note "$(installer_text "Nait-AWG доступен по адресу: $panel_address" "Nait-AWG is available at: $panel_address")"
  note "$(installer_text 'Пользователи, пароль, порт и настройки сохранены. Установщик обновил веб-интерфейс, не перезапуская контейнер AmneziaWG.' 'Clients, password, port and settings are preserved. The installer updated the web interface without restarting the AmneziaWG container.')"
  exit 0
fi

if [[ "${1:-}" != full ]]; then collect_install_options; fi
admin_password="$("$node" "$SOURCE_DIR/scripts/admin-credentials.js" generate)" || fail "$(installer_text 'Не удалось сгенерировать пароль администратора.' 'Could not generate the administrator password.')"

# Recheck before writing; a running VPN is not sufficient if its config/profile is stale.
"$node" "$SOURCE_DIR/scripts/selfhost-preflight.js" >/dev/null
[[ "$(docker inspect --format '{{.State.StartedAt}}' "$awg_container")" == "$awg_started_at" ]] || fail "$(installer_text 'Контейнер AWG перезапустился во время проверки; повторите позже.' 'AWG container restarted during preflight; retry later.')"

note "$(installer_text 'Устанавливаем панель. Контейнер VPN перезапускать не будем...' 'Installing the panel. The VPN container will not be restarted...')"
install -d -m 0755 /opt/naitlab
install -d -m 0750 "$stage/receiver" "$stage/data" "$stage/tls" "$stage/runtime"
cp -R -- "$SOURCE_DIR/app" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$stage/"
cp -R -- "$SOURCE_DIR/vendor/receiver/." "$stage/receiver/"
cp -R -- "$stage/node-v24.20.0-linux-x64/." "$stage/runtime/"
PATH="$stage/runtime/bin:$PATH" run_logged "$(installer_text 'Устанавливаем библиотеки веб-панели...' 'Installing web panel dependencies...')" "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
PATH="$stage/runtime/bin:$PATH" run_logged "$(installer_text 'Устанавливаем библиотеки внутреннего сервиса...' 'Installing internal service dependencies...')" "$stage/runtime/bin/node" "$stage/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --prefix "$stage/receiver" --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error
rm -f -- "$stage/$NODE_ARCHIVE"
rm -rf -- "$stage/node-v24.20.0-linux-x64"

if ! getent group nait-awg >/dev/null; then groupadd --system nait-awg; fi
if ! getent passwd nait-awg >/dev/null; then
  useradd --system --gid nait-awg --groups docker --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin nait-awg
fi
getent group docker | grep -qw nait-awg || usermod -aG docker nait-awg
nait_awg_gid="$(getent group nait-awg | cut -d: -f3)"

run_logged "$(installer_text 'Создаём HTTPS-сертификат веб-панели...' 'Creating the web panel HTTPS certificate...')" openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
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
[[ ! -e "$INSTALL_DIR" ]] || fail "$(installer_text "Каталог $INSTALL_DIR появился во время установки; перезаписывать его не будем." "$INSTALL_DIR appeared during installation; refusing to overwrite it.")"
mv -- "$stage" "$INSTALL_DIR"
stage=''
node="$INSTALL_DIR/runtime/bin/node"
install -m 0644 "$SOURCE_DIR/deploy/nait-awg-selfhost.service" "/etc/systemd/system/$PANEL_UNIT"
install -m 0644 "$SOURCE_DIR/deploy/nait-awg-receiver-selfhost.service" "/etc/systemd/system/$RECEIVER_UNIT"
install -m 0644 "$SOURCE_DIR/deploy/$DOMAIN_UNIT" "/etc/systemd/system/$DOMAIN_UNIT"
systemctl daemon-reload
systemctl --quiet enable --now "$DOMAIN_UNIT"
note "$(installer_text 'Запускаем внутренний сервис панели...' 'Starting the internal panel service...')"
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
  note "$(installer_text 'Внутренний сервис не запустился. Последние сообщения:' 'Internal service did not start. Recent messages:')"
  journalctl -u "$RECEIVER_UNIT" -n 25 --no-pager >&2 || true
  fail "$(installer_text "Проверьте состояние: sudo systemctl status $RECEIVER_UNIT" "Check status: sudo systemctl status $RECEIVER_UNIT")"
fi
note "$(installer_text 'Запускаем веб-панель...' 'Starting the web panel...')"
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
  note "$(installer_text 'Панель не запустилась. Последние сообщения:' 'Panel did not start. Recent messages:')"
  journalctl -u "$PANEL_UNIT" -n 25 --no-pager >&2 || true
  fail "$(installer_text "Проверьте состояние: sudo systemctl status $PANEL_UNIT" "Check status: sudo systemctl status $PANEL_UNIT")"
fi
[[ "$(docker inspect --format '{{.State.StartedAt}}' "$awg_container")" == "$awg_started_at" ]] || fail "$(installer_text 'Время запуска контейнера AWG изменилось во время установки; немедленно проверьте сервер.' 'AWG container start time changed during installation; investigate immediately.')"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  run_logged "$(installer_text "Открываем TCP-порт $panel_port в UFW для веб-панели..." "Opening TCP port $panel_port in UFW for the web panel...")" ufw allow "$panel_port/tcp" comment 'Nait-AWG web panel'
  run_logged "$(installer_text 'Открываем TCP-порт 80 в UFW для сертификатов домена...' 'Opening TCP port 80 in UFW for domain certificates...')" ufw allow '80/tcp' comment 'Nait-AWG certificates'
fi
panel_address="$("$node" "$SOURCE_DIR/scripts/panel-access.js" url "$public_endpoint" "$panel_port")" || fail "$(installer_text 'Не удалось подготовить адрес панели.' 'Could not prepare the panel address.')"
note "$(installer_text "Готово: $panel_address (самоподписанный сертификат)." "Done: $panel_address (self-signed certificate).")"
note "$(installer_text 'Логин панели: admin' 'Panel username: admin')"
note "$(installer_text "Пароль: $admin_password" "Password: $admin_password")"
note "$(installer_text '(Сохраните пароль и не забудьте сменить его в настройках.)' '(Save the password and remember to change it in settings.)')"
if [[ "${1:-}" == full ]]; then
  note "$(installer_text "AmneziaWG 3.1 установлен и запущен: UDP-порт $awg_port. Выдайте первый доступ в веб-панели." "AmneziaWG 3.1 is installed and running on UDP port $awg_port. Add the first client in the web panel.")"
else
  note "$(installer_text 'Установщик панели не перезапускал существующий контейнер AmneziaWG.' 'The panel installer did not restart the existing AmneziaWG container.')"
fi
note "$(installer_text 'Если подключение недоступно, проверьте TCP-порт панели и UDP-порт VPN в сетевом экране хостинга.' 'If the connection is unavailable, check the panel TCP port and VPN UDP port in your hosting firewall.')"
note "$(installer_text 'Для подключения домена разрешите у хостинга TCP-порт 80. Он нужен для выпуска и продления сертификата, не для входа в панель.' 'To connect a domain, allow TCP port 80 in your hosting firewall. It is needed for certificate issuance and renewal, not for signing in to the panel.')"
