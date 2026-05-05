#!/bin/sh
set -eu

RAR_VERSION="7.10"

if [ ! -x /usr/local/bin/rar ]; then
  arch="$(uname -m)"
  case "$arch" in
    x86_64) suffix="x64" ;;
    *) echo "unsupported arch: $arch" >&2; exit 1 ;;
  esac

  curl -fsSL "https://www.rarlab.com/rar/rarlinux-${suffix}-${RAR_VERSION%.*}${RAR_VERSION#*.}.tar.gz" \
    | tar -xzf - -C /tmp
  install -m 0755 /tmp/rar/rar /usr/local/bin/rar
  rm -rf /tmp/rar
fi

exec node dist/index.js
