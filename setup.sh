#!/usr/bin/env bash
#
# Install dsh-plugin-git-commit-push into the active DSH profile on macOS or
# Linux. The Windows equivalent is setup.ps1; both do the same three things and
# both delegate the profile-manifest edit to lib/profile-edit.mjs, so the risky
# step is the same reviewed code on every platform.
#
#   1. links the plugin into the profile's package.json as a `link:` dependency;
#   2. appends the package to `dsh.profile.bundles`;
#   3. writes the mount row into the profile's cordis.patch.yml.
#
# Step 3 is required, not cosmetic: measured on the reserved `desktop` profile,
# a linked and bundled package with no mount row loads nothing at all. The
# package therefore declares no `dsh.bundle.patch`, so this row is the single
# mount and there is no double-mount to guard against.
#
# Restart DSH afterwards. `patchReload: live` re-reads the mount row but does
# NOT re-import an ESM module, so code changes need a restart.
#
# Usage:
#   ./setup.sh [profile]            install (default profile: desktop)
#   ./setup.sh [profile] --uninstall
#
# Environment:
#   DSH_HOME   DSH home directory (default: ~/.dsh)

set -eu

plugin_dir=$(cd -- "$(dirname -- "$0")" && pwd)
plugin_name='dsh-plugin-git-commit-push'
dsh_home=${DSH_HOME:-"$HOME/.dsh"}

profile='desktop'
uninstall=0
for arg in "$@"; do
  case "$arg" in
    --uninstall|-u) uninstall=1 ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
    *) profile=$arg ;;
  esac
done

profile_dir="$dsh_home/profiles/$profile"

ok()   { printf '  [ok]   %s\n' "$1"; }
info() { printf '  [info] %s\n' "$1"; }
warn() { printf '  [warn] %s\n' "$1"; }
die()  { printf '  [fail] %s\n' "$1" >&2; exit 1; }

printf '\n%s %s\n\n' "$plugin_name" "$([ "$uninstall" = 1 ] && echo uninstall || echo install)"

# ---------------------------------------------------------------- preconditions
[ -d "$profile_dir" ] || die "profile directory not found: $profile_dir"
manifest="$profile_dir/package.json"
patch_file="$profile_dir/cordis.patch.yml"
[ -f "$manifest" ] || die "not a DSH profile (no package.json): $profile_dir"
[ -f "$patch_file" ] || die "not a DSH profile (no cordis.patch.yml): $profile_dir"

if command -v git >/dev/null 2>&1; then
  ok "git found: $(command -v git)"
else
  warn 'git was not found on PATH. The plugin needs it at runtime; install Git before using it.'
fi

# Prefer a node already on PATH; otherwise use the runtime DSH ships with.
node_bin=''
if command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
else
  for candidate in \
    "$dsh_home/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
  do
    if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
  done
fi
[ -n "$node_bin" ] || die 'no node executable found. Install Node 20+, or set DSH_HOME to your DSH home.'
ok "node: $node_bin"

pnpm_cli="$dsh_home/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"

# ------------------------------------------------------------------- backups
stamp=$(date +%Y%m%d-%H%M%S)
for file in "$manifest" "$patch_file"; do
  backup="$file.git-commit-plugin.bak"
  if [ ! -f "$backup" ]; then
    # `cp -p` preserves the mode; a plain cp is fine but this keeps parity with
    # the Windows installer's intent (never overwrite an existing backup).
    cp -p "$file" "$backup"
    ok "backed up $(basename "$file") -> $(basename "$backup")"
  fi
  cp -p "$file" "$file.pre-install-$stamp"
done
info "pre-install snapshots written as *.pre-install-$stamp"

# ------------------------------------------------------- 1+2. profile manifest
if [ "$uninstall" = 1 ]; then
  "$node_bin" "$plugin_dir/lib/profile-edit.mjs" \
    --profile-dir "$profile_dir" --package "$plugin_name" --remove || die 'manifest edit failed'
else
  "$node_bin" "$plugin_dir/lib/profile-edit.mjs" \
    --profile-dir "$profile_dir" --package "$plugin_name" --link "$plugin_dir" || die 'manifest edit failed'
fi
ok 'package.json updated'

# ------------------------------------------------------------ 3. mount row
begin_marker='# >>> dsh-plugin-git-commit-push'
end_marker='# <<< dsh-plugin-git-commit-push'

# Strip any previous block (POSIX awk, no GNU-only flags, no in-place sed: the
# `-i` flag differs between BSD/macOS and GNU, which is exactly the kind of
# portability trap this avoids).
awk -v begin="$begin_marker" -v end="$end_marker" '
  $0 == begin { skipping = 1 }
  skipping != 1 { print }
  $0 == end { skipping = 0; next }
' "$patch_file" > "$patch_file.tmp"
mv "$patch_file.tmp" "$patch_file"

if [ "$uninstall" = 1 ]; then
  ok 'cordis.patch.yml: mount row removed'
else
  {
    printf '\n%s\n' "$begin_marker"
    printf '%s\n' '- insert:'
    printf '    - id: git-commit-push\n'
    printf "      name: '%s'\n" "$plugin_name"
    printf '%s\n' "$end_marker"
  } >> "$patch_file"
  ok 'cordis.patch.yml: mount row inserted'
fi

# ---------------------------------------------------------------- 4. link it
if [ "$uninstall" = 1 ]; then
  info 'skipping pnpm install (removal)'
else
  if [ -f "$pnpm_cli" ]; then
    info 'running pnpm install in the profile (this may take a moment)...'
    ( cd "$profile_dir" && "$node_bin" "$pnpm_cli" install ) || die 'pnpm install failed'
    ok 'package linked into the profile'
  else
    warn "bundled pnpm not found at $pnpm_cli"
    warn "run this yourself to link the package:  cd '$profile_dir' && pnpm install"
  fi

  if [ -e "$profile_dir/node_modules/$plugin_name" ]; then
    ok "module present at node_modules/$plugin_name"
  else
    warn "node_modules/$plugin_name is missing; the profile will not find the plugin"
    warn 'run `pnpm install` inside the profile directory and try again'
  fi
fi

# --------------------------------------------------------------------- report
printf '\n'
if [ "$uninstall" = 1 ]; then
  printf 'Uninstalled. Restart DeepSeek Harness for the bundle set to change.\n'
  printf 'Backups: %s\n\n' "$manifest.git-commit-plugin.bak"
else
  printf 'Done. Restart DeepSeek Harness to load the plugin.\n\n'
  printf '  A bundle change is read at profile start, not live, and a host-code\n'
  printf '  change needs a fresh ESM import. Quit DSH first, then start it again.\n\n'
  printf '  After the restart you get:\n'
  printf '    - tool   git_commit_push   (prepare / apply / auto)  [costs model tokens]\n'
  printf '    - command /commit-push     (no model involved)      [0 model tokens]\n\n'
  printf '  Settings: %s\n' "$plugin_dir/git-commit-push.config.json"
  printf '  Backups : %s\n\n' "$manifest.git-commit-plugin.bak"
fi

exit 0
