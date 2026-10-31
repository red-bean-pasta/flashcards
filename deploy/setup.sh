#! /bin/bash

set -eu -o pipefail

# ANSI color codes
R=$'\e[0;31m'
G=$'\e[0;32m'
B=$'\e[0;34m'
Y=$'\e[0;33m'
I=$'\e[0m'

Script_Dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
Default_App_Dir="$(cd "$Script_Dir/.." && pwd)"

# Global variables
Domain="${DOMAIN:-${SERVER_DOMAIN:-}}"
Port="${PORT:-${SERVER_PORT:-443}}"
App_Dir="${Default_App_Dir}"
Caddy_Dir="/etc/caddy"
Skip_Build=false


Log() {
  local prefix=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -e) prefix="${R}ERROR: ${I}"; shift ;;
      -w) prefix="${Y}WARNING: ${I}"; shift ;;
      -s) prefix="${G}SUCCESS: ${I}"; shift ;;
      -i) prefix="${B}INFO: ${I}"; shift ;;
      *) break ;;
    esac
  done
  echo "${prefix}$*" >&2
}


PrintHelp() {
  cat <<EOF
Flashcards Caddy Deployment Script

Usage:
  DOMAIN=flashcards.example.com [PORT=443] sudo -E ./setup.sh [OPTIONS]
  sudo ./setup.sh --domain flashcards.example.com [--port 443] [OPTIONS]

Options:
  -d, --domain <domain>    Domain name for the site (overrides DOMAIN/SERVER_DOMAIN env)
  -p, --port <port>        Port to bind HTTPS (default: 443, overrides PORT/SERVER_PORT env)
  -a, --app-dir <dir>      Path to the Flashcards application directory (default: $Default_App_Dir)
  -c, --caddy-dir <dir>    Path to Caddy configuration directory (default: /etc/caddy)
      --skip-build         Skip running 'npm ci && npm run build'
  -h, --help               Show this help message

Environment Variables:
  DOMAIN / SERVER_DOMAIN   Domain name for Flashcards
  PORT / SERVER_PORT       Port number (default: 443)
EOF
}


CheckIfRoot() {
  if [[ "$EUID" -ne 0 ]]; then
    Log -e "Root privileges required. Please run with sudo: sudo DOMAIN=... $0"
    exit 1
  fi
}


CheckIfValidPort() {
  local port="${1:-}"
  if [[ "$port" =~ ^[0-9]+$ ]] && (( 10#"$port" >= 1 && 10#"$port" <= 65535 )); then
    return 0
  fi
  return 1
}


ParseArgs() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d|--domain)
        [[ $# -ge 2 ]] || { Log -e "Option '$1' requires an argument"; exit 1; }
        Domain="$2"
        shift 2
        ;;
      -p|--port)
        [[ $# -ge 2 ]] || { Log -e "Option '$1' requires an argument"; exit 1; }
        Port="$2"
        shift 2
        ;;
      -a|--app-dir)
        [[ $# -ge 2 ]] || { Log -e "Option '$1' requires an argument"; exit 1; }
        App_Dir="$2"
        shift 2
        ;;
      -c|--caddy-dir)
        [[ $# -ge 2 ]] || { Log -e "Option '$1' requires an argument"; exit 1; }
        Caddy_Dir="$2"
        shift 2
        ;;
      --skip-build)
        Skip_Build=true
        shift
        ;;
      -h|--help)
        PrintHelp
        exit 0
        ;;
      *)
        if [[ -z "$Domain" ]]; then
          Domain="$1"
          shift
        else
          Log -e "Unknown argument: $1"
          PrintHelp
          exit 1
        fi
        ;;
    esac
  done
}


ValidateInputs() {
  if [[ -z "$Domain" ]]; then
    if [[ -t 0 ]]; then
      read -rp "Enter domain for Flashcards (e.g. flashcards.example.com): " Domain
      Domain="$(echo "$Domain" | xargs)"
    fi
  fi

  if [[ -z "$Domain" ]]; then
    Log -e "Domain is required. Set DOMAIN environment variable or pass --domain <domain>."
    exit 1
  fi

  if ! CheckIfValidPort "$Port"; then
    Log -e "Invalid port '$Port'. Must be an integer between 1 and 65535."
    exit 1
  fi

  if [[ ! -d "$App_Dir" ]]; then
    Log -e "App directory '$App_Dir' does not exist."
    exit 1
  fi
}


BuildProject() {
  if [[ "$Skip_Build" == "true" ]]; then
    Log -i "Skipping project build (--skip-build requested)"
    return 0
  fi

  Log -i "Checking Node.js and npm..."
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    Log -e "Node.js and npm are required to build the frontend. Please install Node.js 20+."
    exit 1
  fi

  Log -i "Building Flashcards in $App_Dir..."
  (
    cd "$App_Dir"
    npm ci
    npm run build
  )

  local dist_dir="$App_Dir/dist"
  if [[ ! -d "$dist_dir" || ! -f "$dist_dir/index.html" ]]; then
    Log -e "Build completed but '$dist_dir/index.html' was not found."
    exit 1
  fi

  # Ensure Caddy can read the compiled static assets
  chmod -R a+rX "$dist_dir"
  Log -s "Frontend assets built successfully in $dist_dir"
}


ConfigureCaddy() {
  local root_caddyfile="$Caddy_Dir/Caddyfile"
  local conf_d="$Caddy_Dir/conf.d"
  local site_config="$conf_d/flashcards.caddy"
  local site_address

  if [[ "$Port" -eq 443 ]]; then
    site_address="https://${Domain}"
  else
    site_address="https://${Domain}:${Port}"
  fi

  Log -i "Configuring Caddy for $site_address..."
  mkdir -p "$conf_d"

  local backup_created=false
  local backup_path=""

  if [[ -f "$root_caddyfile" ]]; then
    local timestamp; timestamp="$(date +%s)"
    backup_path="${root_caddyfile}.bak.${timestamp}"
    cp "$root_caddyfile" "$backup_path"
    if [[ ! -f "${root_caddyfile}.bak" ]]; then
      cp "$root_caddyfile" "${root_caddyfile}.bak"
    fi
    backup_created=true
    Log -i "Created backup of existing Caddyfile at $backup_path"

    # Check silently if conf.d is already imported
    if ! grep -qE "import[[:space:]]+(conf\.d/|\"$Caddy_Dir/conf\.d/|/etc/caddy/conf\.d/)" "$root_caddyfile"; then
      Log -i "Appending 'import conf.d/*.caddy' to $root_caddyfile"
      printf "\n# Added by Flashcards deployment script\nimport conf.d/*.caddy\n" >> "$root_caddyfile"
    else
      Log -i "Existing Caddyfile already imports conf.d"
    fi
  else
    Log -i "Creating root $root_caddyfile with conf.d import"
    cat << 'EOF' > "$root_caddyfile"
# Caddyfile created by Flashcards deployment
import conf.d/*.caddy
EOF
  fi

  Log -i "Writing site configuration to $site_config"
  cat << EOF > "$site_config"
# Flashcards site configuration
# Domain: ${Domain}
# Port: ${Port}

${site_address} {
    root * ${App_Dir}/dist

    # Static compression
    encode zstd gzip

    # Request limits for static hosting without reverse proxy / DDoS shield
    request_body {
        max_size 10KB
    }

    # Restrict HTTP methods to read-only static asset requests
    @disallowed_methods not method GET HEAD OPTIONS
    error @disallowed_methods 405

    # Security headers
    header {
        # Strip Server header to prevent fingerprinting
        -Server

        # Enforce HTTPS strictly (1 year, subdomains, preload)
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"

        # Prevent MIME type sniffing
        X-Content-Type-Options "nosniff"

        # Deny clickjacking / embedding Flashcards inside other sites
        X-Frame-Options "DENY"

        # Referrer policy
        Referrer-Policy "strict-origin-when-cross-origin"

        # Restrict browser feature permissions
        Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"

        # Content Security Policy:
        # - Tightened connect-src to origin and Microsoft auth/graph/storage endpoints
        # - style-src unsafe-inline allowed for Svelte dynamic inline style variables
        # - frame-src and form-action for OneDrive picker and OAuth
        # - upgrade-insecure-requests forces HTTPS on all requests
        Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://graph.microsoft.com https://login.microsoftonline.com https://*.1drv.com https://*.1drv.ms https://*.live.com https://*.storage.live.com; frame-src https://onedrive.live.com https://login.microsoftonline.com https://login.live.com; form-action 'self' https://onedrive.live.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests;"
    }

    # SPA routing: serve index.html for client-side routes
    try_files {path} /index.html

    # File server with hidden dotfiles protection
    file_server {
        hide .*
    }

    # Explicitly deny dotfiles with 404
    @dotfiles path */.*
    error @dotfiles 404
}
EOF

  # Validate configuration with Caddy
  if command -v caddy >/dev/null 2>&1; then
    Log -i "Validating Caddy configuration..."
    if ! caddy validate --config "$root_caddyfile" >/dev/null 2>&1; then
      Log -e "Caddy configuration validation failed!"
      if [[ "$backup_created" == "true" && -n "$backup_path" ]]; then
        Log -w "Rolling back Caddyfile to $backup_path"
        cp "$backup_path" "$root_caddyfile"
      fi
      rm -f "$site_config"
      exit 1
    fi
    Log -s "Caddy configuration validated successfully"
  else
    Log -w "caddy command not found in PATH; skipping validation"
  fi
}


ReloadCaddy() {
  Log -i "Reloading Caddy service..."
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files caddy.service >/dev/null 2>&1; then
    if systemctl is-active --quiet caddy; then
      systemctl reload caddy
      Log -s "Caddy service reloaded successfully"
    else
      systemctl start caddy
      Log -s "Caddy service started successfully"
    fi
  elif command -v caddy >/dev/null 2>&1; then
    if caddy reload --config "$Caddy_Dir/Caddyfile" >/dev/null 2>&1; then
      Log -s "Caddy reloaded via caddy CLI"
    else
      Log -w "Could not reload Caddy automatically. Please run: sudo systemctl reload caddy"
    fi
  else
    Log -w "Unable to reload Caddy automatically. Please restart or reload Caddy."
  fi
}


Main() {
  ParseArgs "$@"
  CheckIfRoot
  ValidateInputs

  Log -s "Starting Flashcards Caddy deployment"
  Log -i "Domain: $Domain"
  Log -i "Port:   $Port"
  Log -i "App:    $App_Dir"

  BuildProject
  ConfigureCaddy
  ReloadCaddy

  local live_url="https://${Domain}"
  if [[ "$Port" -ne 443 ]]; then
    live_url="https://${Domain}:${Port}"
  fi

  echo
  Log -s "Deployment complete! Flashcards is live at $live_url"
}

Main "$@"
