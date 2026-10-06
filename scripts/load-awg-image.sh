#!/usr/bin/env bash
# Source-only loader for the bundled official runtime; never contact a registry.
readonly AWG_IMAGE_ARCHIVE="$SOURCE_DIR/bundle/amneziawg-3.1.20260812-linux-amd64.tar.gz"
readonly AWG_ARCHIVE_SHA256=388448f1f24b62961101499f8111a89d0ecca928d7e1b551e3de8524f90fcbdd
readonly AWG_MANIFEST_ID=sha256:946043ed2fd6bd730ad187a7bec96fa158eeb68e555e83896f7cdb33bbfbe8c5
readonly AWG_CONFIG_ID=sha256:0215368efe8b9507b049f11943f26e132b20a09fa861c2e5a90fadd5854e7d64
# Archive tag is only a local lookup after load. All runs use the verified immutable ID.
readonly AWG_IMAGE_TAG=amnezia-awg2:latest
readonly AWG_TOOLS_VERSION=v3.1.20260812

verify_awg_archive() {
  [[ -f "$AWG_IMAGE_ARCHIVE" && ! -L "$AWG_IMAGE_ARCHIVE" ]] || fail 'В комплекте отсутствует архив AmneziaWG. Скачайте полный проект; загрузка из Docker Hub не используется.'
  command -v sha256sum >/dev/null 2>&1 || fail 'Для проверки архива нужна команда sha256sum.'
  printf '%s  %s\n' "$AWG_ARCHIVE_SHA256" "$AWG_IMAGE_ARCHIVE" | sha256sum --check --status || fail 'Контрольная сумма архива AmneziaWG не совпала. Загрузка отменена.'
}

load_awg_image() {
  local details actual_id image_os image_arch extra
  verify_awg_archive
  run_logged 'Загружаем официальный Docker-образ AmneziaWG 3.1 из комплекта...' docker image load --input "$AWG_IMAGE_ARCHIVE" || return "$?"
  details="$(docker image inspect "$AWG_IMAGE_TAG" --format '{{.Id}} {{.Os}} {{.Architecture}}')" || fail 'Не удалось проверить загруженный образ AmneziaWG.'
  read -r actual_id image_os image_arch extra <<< "$details"
  # containerd identifies this image by its manifest; classic Docker uses its config.
  [[ "$actual_id" == "$AWG_MANIFEST_ID" || "$actual_id" == "$AWG_CONFIG_ID" ]] || fail 'Идентификатор загруженного образа AmneziaWG не совпал с комплектом.'
  [[ "$image_os" == linux && "$image_arch" == amd64 && -z "$extra" ]] || fail 'Загруженный образ AmneziaWG должен быть Linux amd64.'
  readonly IMAGE="$actual_id"
}

verify_awg_tools() {
  local output status=0 tools_name tools_version extra
  installer_log_init || return 1
  printf 'Проверяем инструменты AmneziaWG...\n' >&2
  printf '\n=== Проверяем инструменты AmneziaWG ===\n' >>"$NAIT_AWG_INSTALL_LOG" || return 1
  # This command contains no keys/configs. Keep stderr in the private log, not in
  # the version parser: Docker warnings must not change the stdout contract.
  if output="$(docker run --pull=never --rm --network none --entrypoint awg "$IMAGE" --version 2>>"$NAIT_AWG_INSTALL_LOG")"; then
    status=0
  else
    status=$?
  fi
  printf '%s\nКод завершения: %s\n' "$output" "$status" >>"$NAIT_AWG_INSTALL_LOG" || return 1
  [[ "$status" -eq 0 ]] || fail "Не удалось запустить инструменты AmneziaWG (код $status)."
  # Compare the pinned local version, never the latest upstream release or the
  # complete display line (the official CLI appends a website URL).
  read -r tools_name tools_version extra <<< "${output//$'\r'/}"
  [[ "$tools_name" == amneziawg-tools && "$tools_version" == "$AWG_TOOLS_VERSION" ]] \
    || fail "Версия инструментов AmneziaWG не совпала с комплектом: ожидалась $AWG_TOOLS_VERSION, получено ${tools_name:-пустой ответ} ${tools_version:-}."
}
