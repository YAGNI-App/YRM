#!/bin/sh
# Container entrypoint: arguments are yrm arguments. On first start with an
# empty /data, write a config so the dashboard and import work straight away.
# YRM_SELF (comma-separated addresses) and YRM_NAME fill it in; edit
# /data/yrm.config.ts afterwards for anything else.
set -eu

if [ ! -f yrm.config.ts ] && [ ! -f yrm.config.js ] && [ ! -f yrm.config.json ] && [ "${1:-}" != "init" ]; then
  self_args=""
  for addr in $(printf '%s' "${YRM_SELF:-}" | tr ',' ' '); do
    self_args="$self_args --self $addr"
  done
  # Addresses contain no spaces, so splitting self_args is intended.
  # shellcheck disable=SC2086
  if [ -n "${YRM_NAME:-}" ]; then
    yrm init --timezone "${TZ:-UTC}" --name "$YRM_NAME" $self_args >&2
  else
    yrm init --timezone "${TZ:-UTC}" $self_args >&2
  fi
fi

exec yrm "$@"
