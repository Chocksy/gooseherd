#!/bin/sh
# Docker entrypoint — grants Docker socket access for sandbox (DooD) mode.
# If /var/run/docker.sock exists, detect its GID and add the gooseherd user
# to a matching group so the non-root process can talk to Docker.

SOCKET="/var/run/docker.sock"

if [ -S "$SOCKET" ]; then
  SOCKET_GID=$(stat -c '%g' "$SOCKET" 2>/dev/null)
  if [ -n "$SOCKET_GID" ] && [ "$SOCKET_GID" != "0" ]; then
    # Socket owned by a non-root group — add user to that group
    groupadd -g "$SOCKET_GID" -o docker-host 2>/dev/null || true
    usermod -aG docker-host gooseherd 2>/dev/null || true
  else
    # Socket owned by root — make it group-readable for gooseherd
    chmod 666 "$SOCKET" 2>/dev/null || true
  fi
fi

exec gosu gooseherd "$@"
