#!/usr/bin/env bash
# Source-only installer localization. This block is also embedded in install.sh:
# the curl | bash entrypoint must choose a language before downloading helpers.
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
  printf '\nВыберите язык / Select language:\n  1) RU\n  2) EN\n\n' >&2
  while true; do
    if ! read -r -p 'Введите номер / Enter number [1-2]: ' language_choice </dev/tty; then
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
