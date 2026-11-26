#!/bin/bash
# Sourced by setup.sh. Prints the node binary to bake into the launchd plist.
# A Node manager path (nvm, fnm, volta) changes when the user switches versions and would leave the hub
# service pointing at a missing binary, so a system install wins when one exists.
# TRANTOR_NODE_CANDIDATES (space separated) overrides the system locations, for tests.
pick_node() {
  local cur c
  cur="$(command -v node)"
  for c in ${TRANTOR_NODE_CANDIDATES:-/opt/homebrew/bin/node /usr/local/bin/node}; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  [ -n "$cur" ] && echo "$cur"
  case "$cur" in
    *"/.nvm/"*|*"/.fnm/"*|*"/fnm_multishells/"*|*"/.volta/"*|*"/.asdf/"*|*"/.local/share/mise/"*)
      echo "warning: node is at $cur, a Node manager path that changes when you switch versions; install Node system-wide (brew install node) and re-run trantor setup if the hub stops starting" >&2;;
  esac
  return 0
}
