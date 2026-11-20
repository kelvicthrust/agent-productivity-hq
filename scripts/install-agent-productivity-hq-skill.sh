#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: sh install-agent-productivity-hq-skill.sh claude|codex" >&2
  exit 1
fi

case "$1" in
  claude) skill_root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills" ;;
  codex) skill_root="$HOME/.agents/skills" ;;
  *)
    echo "Usage: sh install-agent-productivity-hq-skill.sh claude|codex" >&2
    exit 1
    ;;
esac

cd -- "$(dirname -- "$0")"
read -r expected archive < CLI-SHA256SUM
case "$archive" in
  kelvicthrust-agent-productivity-hq-[0-9]*.tgz)
    case "$archive" in
      */*) echo "Invalid package filename in CLI-SHA256SUM." >&2; exit 1 ;;
    esac
    ;;
  *) echo "Invalid package filename in CLI-SHA256SUM." >&2; exit 1 ;;
esac

if [ ! -f "$archive" ]; then
  echo "Place $archive alongside this installer, then retry." >&2
  exit 1
fi
destination="$skill_root/agent-productivity-hq"
app_support="$HOME/Library/Application Support/Agent Productivity Beta"
mkdir -p "$app_support"
archive_stage=$(mktemp "$app_support/.archive.XXXXXX")
skill_stage=''
skill_lock=''
cleanup() {
  rm -f -- "$archive_stage"
  if [ -n "$skill_stage" ]; then
    rm -f -- "$skill_stage/SKILL.md" "$skill_stage/private-rc.md" "$skill_stage/LICENSE"
    rmdir -- "$skill_stage"
  fi
  if [ -n "$skill_lock" ]; then
    rmdir -- "$skill_lock"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cp -- "$archive" "$archive_stage"
actual=$(/usr/bin/shasum -a 256 -- "$archive_stage")
if [ "${actual%% *}" != "$expected" ]; then
  echo "Checksum mismatch for $archive. Use the archive supplied with this release candidate." >&2
  exit 1
fi

mkdir -p "$skill_root"
lock="$skill_root/.agent-productivity-hq.installing"
if ! mkdir -- "$lock"; then
  echo "Another agent-productivity-hq installer may be running for this profile. Retry when it finishes." >&2
  exit 1
fi
skill_lock=$lock
if [ -e "$destination" ] || [ -L "$destination" ]; then
  if [ -L "$destination" ] ||
    ! cmp -s agent-productivity-hq/SKILL.md "$destination/SKILL.md" ||
    ! cmp -s agent-productivity-hq/LICENSE "$destination/LICENSE" ||
    ! cmp -s agent-productivity-hq/private-rc.md "$destination/private-rc.md"; then
    echo "An agent-productivity-hq skill already exists at $destination. Move it aside before installing this release candidate." >&2
    exit 1
  fi
else
  skill_stage=$(mktemp -d "$skill_root/.agent-productivity-hq.XXXXXX")
  cp -- agent-productivity-hq/private-rc.md "$skill_stage/private-rc.md"
  cp -- agent-productivity-hq/SKILL.md "$skill_stage/SKILL.md"
  cp -- agent-productivity-hq/LICENSE "$skill_stage/LICENSE"
fi
if [ -d "$app_support/$archive" ]; then
  echo "Expected the archive path to be a file. Move the directory $app_support/$archive aside before retrying." >&2
  exit 1
fi
mv -fh -- "$archive_stage" "$app_support/$archive"
if [ -n "$skill_stage" ]; then
  mv -h -- "$skill_stage" "$destination"
  skill_stage=''
fi
printf 'Installed %s\n' "$destination"
