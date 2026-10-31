#!/bin/bash
set -Eeuo pipefail
umask 022

Script_Dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
Source_Dir="$(cd "$Script_Dir/.." && pwd)"
Deploy_Dir=/srv/flashcards
Caddy_Dir=/etc/caddy
Domain="${DOMAIN:-${SERVER_DOMAIN:-}}"
Port="${PORT:-${SERVER_PORT:-443}}"
Skip_Build=false
Txn_Dir=""
Root_Backup=""
Site_Backup=""
Release_Dir=""
Transaction_Started=false
Committed=false
Activation_Attempted=false
Assets_Changed=false
Had_Root=false
Had_Site=false
Old_Dist_Kind=absent
Old_Link=""

Log() { printf '%s\n' "$*" >&2; }
Die() { Log "ERROR: $*"; exit 1; }

PrintHelp() {
  cat <<'HELP'
Flashcards deployment (existing, active Caddyfile-based caddy.service required)

Usage:
  sudo ./deploy/setup.sh --domain flashcards.example.com [--port 443]
  sudo DOMAIN=flashcards.example.com PORT=443 ./deploy/setup.sh

Options:
  -d, --domain <hostname>  DNS hostname (DOMAIN / SERVER_DOMAIN)
  -p, --port <port>        HTTPS port, 1-65535 (PORT / SERVER_PORT; default 443)
      --skip-build         Deploy an existing dist/ built as an unprivileged user
  -h, --help               Show help

By default, npm ci and npm run build run as the non-root SUDO_USER.
Direct root invocation must use --skip-build. Building requires Node.js >=22.12.
Assets are served at /srv/flashcards/dist; Caddy uses /etc/caddy/Caddyfile.
The service reload validates and provisions configuration in its own environment.
No Caddy environment file is read by this script. Existing global options are kept.
HELP
}

ParseArgs() {
  while (( $# )); do
    case "$1" in
      -d|--domain|-p|--port)
        (( $# >= 2 )) || Die "Option $1 requires an argument"
        case "$1" in
          -d|--domain) Domain="$2" ;;
          -p|--port) Port="$2" ;;
        esac
        shift 2 ;;
      --skip-build) Skip_Build=true; shift ;;
      -h|--help) PrintHelp; exit 0 ;;
      *) Die "Unknown argument: $1" ;;
    esac
  done
}

ValidateInputs() {
  [[ -n "$Domain" ]] || Die 'Set DOMAIN or pass --domain <hostname>.'
  Domain="${Domain,,}"
  [[ ${#Domain} -le 253 ]] || Die 'Hostname exceeds 253 characters.'
  local label
  local -a labels
  IFS=. read -r -a labels <<< "$Domain"
  [[ "$Domain" != *. && "$Domain" != *..* && "$Domain" != *$'\n'* ]] || Die 'Invalid DNS hostname.'
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]] || Die 'Invalid DNS hostname.'
  done
  [[ "$Port" =~ ^[0-9]{1,5}$ ]] || Die 'Port must be an integer between 1 and 65535.'
  Port=$((10#$Port))
  (( Port >= 1 && Port <= 65535 )) || Die 'Port must be between 1 and 65535.'
  [[ "$Source_Dir" != "$Deploy_Dir" && "$Source_Dir" != "$Deploy_Dir/"* ]] || Die 'Keep the source repository outside /srv/flashcards.'
  [[ -f "$Source_Dir/package.json" ]] || Die 'Source package.json is missing.'
}

CheckPrerequisites() {
  (( EUID == 0 )) || Die 'Run deployment with sudo (see --help).'
  local command_name
  for command_name in caddy systemctl python3 flock; do
    command -v "$command_name" >/dev/null || Die "Required command missing: $command_name"
  done
  [[ "$(systemctl show -p LoadState --value caddy.service)" == loaded ]] || Die 'caddy.service must be installed.'
  systemctl is-active --quiet caddy.service || Die 'Start the Caddyfile-based caddy.service before deploying.'
  # Serialize deployments before building or modifying shared files.
  exec 9>/run/lock/flashcards-deploy.lock
  flock -n 9 || Die 'Another Flashcards deployment is running.'
  [[ ! -L "$Caddy_Dir/Caddyfile" && ! -L "$Caddy_Dir/conf.d/flashcards.caddy" ]] || Die 'Managed Caddy files must be regular files, not symlinks.'
}

BuildProject() {
  "$Skip_Build" && return 0
  [[ -n "${SUDO_USER:-}" ]] || Die 'Root must use --skip-build with assets built beforehand as an unprivileged user.'
  local build_uid
  build_uid="$(id -u -- "$SUDO_USER")" || Die 'Unknown SUDO_USER.'
  [[ "$build_uid" != 0 ]] || Die 'Refusing to build as root; use --skip-build.'
  command -v runuser >/dev/null || Die 'runuser is required for an unprivileged build.'
  Log "Building as $SUDO_USER..."
  # The child shell expands its own arguments and variables.
  # shellcheck disable=SC2016
  runuser -u "$SUDO_USER" -- bash -c '
    set -euo pipefail
    cd "$1"
    command -v node >/dev/null && command -v npm >/dev/null || { echo "Node.js >=22.12 and npm are required for the build user." >&2; exit 1; }
    node -e '\''const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js >=22.12 is required."); process.exit(1); }'\''
    npm ci
    npm run build
  ' bash "$Source_Dir" 9>&-
}

StageAssets() {
  local dist_dir="$Source_Dir/dist"
  [[ -d "$dist_dir" && ! -L "$dist_dir" && -f "$dist_dir/index.html" ]] || Die 'Build dist/index.html first or run without --skip-build.'
  # Do not publish links to files outside the build output, or special files.
  [[ -z "$(find "$dist_dir" ! -type f ! -type d -print -quit)" ]] || Die 'Build output must contain only regular files and directories.'
  install -d -m 755 "$Deploy_Dir" "$Deploy_Dir/releases"
  Release_Dir="$(mktemp -d "$Deploy_Dir/releases/release.XXXXXXXX")"
  cp -R "$dist_dir/." "$Release_Dir/"
  chown -R root:root "$Release_Dir"
  find "$Release_Dir" -type d -exec chmod 755 {} +
  find "$Release_Dir" -type f -exec chmod 644 {} +
}

BeginTransaction() {
  [[ -d "$Caddy_Dir" ]] || install -d -m 755 "$Caddy_Dir"
  [[ -d "$Caddy_Dir/conf.d" ]] || install -d -m 755 "$Caddy_Dir/conf.d"
  Txn_Dir="$(mktemp -d)"
  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%S%N)"
  Root_Backup="$Caddy_Dir/Caddyfile.$timestamp.bak"
  Site_Backup="$Caddy_Dir/conf.d/flashcards.caddy.$timestamp.bak"
  [[ ! -e "$Root_Backup" && ! -L "$Root_Backup" && ! -e "$Site_Backup" && ! -L "$Site_Backup" ]] || Die 'Configuration backup already exists.'
  if [[ -e "$Caddy_Dir/Caddyfile" ]]; then
    [[ -f "$Caddy_Dir/Caddyfile" ]] || Die 'Caddyfile must be a regular file.'
    cp -p "$Caddy_Dir/Caddyfile" "$Root_Backup"
    Had_Root=true
  fi
  if [[ -e "$Caddy_Dir/conf.d/flashcards.caddy" ]]; then
    [[ -f "$Caddy_Dir/conf.d/flashcards.caddy" ]] || Die 'Site configuration must be a regular file.'
    cp -p "$Caddy_Dir/conf.d/flashcards.caddy" "$Site_Backup"
    Had_Site=true
  fi
  if [[ -L "$Deploy_Dir/dist" ]]; then
    Old_Dist_Kind=symlink
    Old_Link="$(readlink "$Deploy_Dir/dist")"
  elif [[ -e "$Deploy_Dir/dist" ]]; then
    Die 'Existing /srv/flashcards/dist must be a symlink or absent; move it aside before deploying.'
  fi
  Transaction_Started=true
}

WriteSiteConfig() {
  # Render the site example so script and documented configuration cannot drift.
  python3 - "$Script_Dir/Caddyfile.example" "$Txn_Dir/site.new" "$Domain" "$Port" "${Release_Dir##*/}" <<'PY'
import pathlib, sys
source, dest, domain, port, marker = sys.argv[1:]
site = pathlib.Path(source).read_text().replace('\r\n', '\n')
site = site.replace('https://{$DOMAIN:localhost}:{$PORT:443} {',
                    f'https://{domain}:{port} {{\n    vars flashcards_deployment {marker}')
pathlib.Path(dest).write_text(site)
PY
  install -m 644 "$Txn_Dir/site.new" "$Caddy_Dir/conf.d/.flashcards.new"
  mv -f "$Caddy_Dir/conf.d/.flashcards.new" "$Caddy_Dir/conf.d/flashcards.caddy"
}

AdaptConfig() {
  # Adaptation checks syntax without provisioning TLS or requiring service-only secrets.
  # JSON/errors can contain private configuration: never print them and remove on exit.
  if ! caddy adapt --config "$Caddy_Dir/Caddyfile" --adapter caddyfile >"$Txn_Dir/adapt.json" 2>"$Txn_Dir/adapt.err"; then
    Die 'Caddy syntax check failed. Configuration will be restored; private diagnostics were not printed.'
  fi
}

CountSiteImports() {
  python3 - "$Txn_Dir/adapt.json" "${Release_Dir##*/}" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
def count(value):
    if isinstance(value, dict):
        return int(value.get('handler') == 'vars' and value.get('flashcards_deployment') == sys.argv[2]) + sum(map(count, value.values()))
    if isinstance(value, list):
        return sum(map(count, value))
    return 0
print(count(config))
PY
}

ConfigureCaddy() {
  WriteSiteConfig
  if ! "$Had_Root"; then
    printf 'import conf.d/*.caddy\n' > "$Caddy_Dir/Caddyfile"
    chmod 644 "$Caddy_Dir/Caddyfile"
  fi
  AdaptConfig
  local count
  count="$(CountSiteImports)"
  if [[ "$count" == 0 ]]; then
    # Determine inclusion from Caddy's actual parsed configuration, never grep guesses.
    printf '\n# Flashcards sites\nimport conf.d/*.caddy\n' >> "$Caddy_Dir/Caddyfile"
    AdaptConfig
    count="$(CountSiteImports)"
  fi
  [[ "$count" == 1 ]] || Die 'Flashcards must be imported exactly once at site level.'
}

ActivateAssets() {
  Assets_Changed=true
  ln -s "$Release_Dir" "$Deploy_Dir/.dist.next.${Release_Dir##*/}"
  mv -Tf "$Deploy_Dir/.dist.next.${Release_Dir##*/}" "$Deploy_Dir/dist"
}

ReloadCaddy() {
  Activation_Attempted=true
  # ExecReload runs with the service's Environment/EnvironmentFile and identity.
  # Caddy validates/provisions before replacing its running configuration.
  systemctl reload caddy.service || Die 'Caddy reload failed; restoring configuration and assets.'
  systemctl is-active --quiet caddy.service || Die 'Caddy is no longer active; restoring deployment.'
}

RestoreConfig() {
  local result=0
  if "$Had_Root"; then
    cp -p "$Root_Backup" "$Caddy_Dir/Caddyfile" || result=1
  else
    rm -f "$Caddy_Dir/Caddyfile" || result=1
  fi
  if "$Had_Site"; then
    cp -p "$Site_Backup" "$Caddy_Dir/conf.d/flashcards.caddy" || result=1
  else
    rm -f "$Caddy_Dir/conf.d/flashcards.caddy" || result=1
  fi
  return "$result"
}

RestoreAssets() {
  "$Assets_Changed" || return 0
  case "$Old_Dist_Kind" in
    symlink)
      ln -s "$Old_Link" "$Deploy_Dir/.dist.restore.${Release_Dir##*/}" || return 1
      mv -Tf "$Deploy_Dir/.dist.restore.${Release_Dir##*/}" "$Deploy_Dir/dist" || return 1 ;;
    absent) rm -f "$Deploy_Dir/dist" || return 1 ;;
  esac
}

Finish() {
  local status=$? rollback_ok=true
  trap - EXIT INT TERM HUP
  set +e
  if ! "$Committed"; then
    if "$Transaction_Started"; then
      RestoreConfig || rollback_ok=false
      RestoreAssets || rollback_ok=false
      if "$Activation_Attempted"; then
        systemctl reload caddy.service || rollback_ok=false
        systemctl is-active --quiet caddy.service || rollback_ok=false
      fi
      if "$rollback_ok"; then
        Log 'Previous deployment restored.'
      else
        Log "ERROR: Rollback failed; recover using $Root_Backup and $Site_Backup if present."
      fi
    fi
    # Retain a release if rollback failed, so any active symlink remains valid.
    if "$rollback_ok" && [[ -n "$Release_Dir" ]]; then rm -rf -- "$Release_Dir"; fi
    (( status != 0 )) || status=1
  fi
  if [[ -n "$Txn_Dir" ]]; then
    rm -rf -- "$Txn_Dir"
    rm -f "$Caddy_Dir/conf.d/.flashcards.new"
  fi
  rm -f "$Deploy_Dir/.dist.next.${Release_Dir##*/}" "$Deploy_Dir/.dist.restore.${Release_Dir##*/}"
  exit "$status"
}

Main() {
  ParseArgs "$@"
  ValidateInputs
  CheckPrerequisites
  trap Finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  BuildProject
  StageAssets
  BeginTransaction
  ConfigureCaddy
  ActivateAssets
  ReloadCaddy
  Committed=true
  Log "Deployment complete: https://${Domain}:${Port}"
  Log 'Previous asset releases and existing Caddy configuration backups are retained.'
}

Main "$@"
