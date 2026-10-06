#!/usr/bin/env bash
# Source this helper; log only explicitly selected, non-secret command output.
# Do not redirect the entire installer, print command arguments, or enable xtrace.
installer_log_init() {
  if [[ "${1:-}" == new || -z "${NAIT_AWG_INSTALL_LOG:-}" ]]; then
    [[ "$EUID" -eq 0 ]] || { printf 'Ошибка: для журнала установки нужны права root.\n' >&2; return 1; }
    NAIT_AWG_INSTALL_LOG="$(umask 077; mktemp /var/log/nait-awg-install.XXXXXX.log)" || return 1
    export NAIT_AWG_INSTALL_LOG
    printf 'Подробный лог установки: %s\n' "$NAIT_AWG_INSTALL_LOG" >&2
  fi
  # Only a private, root-owned regular file created by the parent installer is reusable.
  [[ "$NAIT_AWG_INSTALL_LOG" == /var/log/nait-awg-install.*.log
    && -f "$NAIT_AWG_INSTALL_LOG" && ! -L "$NAIT_AWG_INSTALL_LOG"
    && "$(stat -c '%u:%a:%h' -- "$NAIT_AWG_INSTALL_LOG")" == 0:600:1 ]] || {
      printf 'Ошибка: небезопасный файл журнала установки.\n' >&2; return 1;
    }
}

installer_log_hint() {
  if [[ -n "${NAIT_AWG_INSTALL_LOG:-}" ]]; then
    printf 'Подробный лог: %s (доступен через sudo).\n' "$NAIT_AWG_INSTALL_LOG" >&2
  fi
}

run_logged() {
  local description="$1" status
  shift
  installer_log_init || return 1
  printf '%s\n' "$description" >&2
  printf '\n=== %s ===\n' "$description" >>"$NAIT_AWG_INSTALL_LOG" || return 1
  if "$@" >>"$NAIT_AWG_INSTALL_LOG" 2>&1; then
    return 0
  else
    status=$?
    printf 'Ошибка на этапе: %s (код %s). Последние сообщения:\n' "$description" "$status" >&2
    tail -n 20 -- "$NAIT_AWG_INSTALL_LOG" >&2 || true
    installer_log_hint
    return "$status"
  fi
}
