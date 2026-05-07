#!/bin/sh
set -eu

RAR_VERSION="7.10"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

if [ ! -x /usr/local/bin/rar ]; then
  log "RAR not found; installing RAR ${RAR_VERSION}"
  arch="$(uname -m)"
  case "$arch" in
    x86_64) suffix="x64"; log "Detected architecture ${arch}; using RAR Linux ${suffix} build" ;;
    *) echo "unsupported arch: $arch" >&2; exit 1 ;;
  esac

  log "Downloading and extracting RAR ${RAR_VERSION}"
  curl -fsSL "https://www.rarlab.com/rar/rarlinux-${suffix}-${RAR_VERSION%.*}${RAR_VERSION#*.}.tar.gz" \
    | tar -xzf - -C /tmp
  log "Installing /usr/local/bin/rar"
  install -m 0755 /tmp/rar/rar /usr/local/bin/rar
  rm -rf /tmp/rar
  log "RAR ${RAR_VERSION} installation complete"
else
  log "RAR already installed at /usr/local/bin/rar"
fi

log "Starting nzb-relay"
exec node dist/index.js
