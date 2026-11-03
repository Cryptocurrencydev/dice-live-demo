#!/usr/bin/env bash
# usage: scripts/timelog.sh start "1. Phase name"   |   scripts/timelog.sh end "notes"
set -e; f="$(dirname "$0")/../TIMELOG.md"; now="$(date '+%Y-%m-%d %H:%M:%S %Z')"
if [ "$1" = start ]; then echo "| $2 | $now | _running_ | |" >> "$f";
else python3 - "$f" "$now" "$2" <<'PY'
import sys;f,now,notes=sys.argv[1:];L=open(f).read().split('\n')
i=max(i for i,l in enumerate(L) if '_running_' in l)
L[i]=L[i].replace('| _running_ | |',f'| {now} | {notes} |');open(f,'w').write('\n'.join(L))
PY
fi
