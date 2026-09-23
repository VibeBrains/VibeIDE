#!/usr/bin/env bash
# Memory guard for a launched Code OSS instance.
#
# A dev build left running can grow to many gigabytes and push the machine into swap. The guard samples
# the memory of the whole instance every few seconds and quits it once the total passes a limit, so
# nobody has to find the runaway copy in Activity Monitor.
#
# The instance is recognised by its throwaway --user-data-dir: every Electron process of the copy (main,
# renderer, GPU, utility, extension hosts) carries it on the command line, and a copy that relaunched
# itself keeps it too. Everything those processes started (MCP servers, ACP agents) is counted as well.
# On macOS memory is the footprint `top` reports — the figure Activity Monitor shows, compressed memory
# included; RSS alone under-counts it badly once memory is compressed or swapped. One `top` pass costs
# most of a second of CPU, hence the 15 s default. On Linux the cheap RSS from `ps` is used.
#
# Usage: memory-guard.sh <user-data-dir> <limit-mb> <log-file> [interval-seconds]
# Exits by itself once no process of the instance is left.

set -uo pipefail

UDD="$1"
LIMIT_MB="$2"
LOG="$3"
INTERVAL="${4:-15}"
REPORT_EVERY=4 # samples between routine log lines (about a minute at the default interval)

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG"; }

# PIDs of the instance: processes carrying its user-data-dir, plus all their descendants. The pattern
# goes to awk through the environment: on its command line awk would match its own process.
instance_pids() {
	ps -A -o pid=,ppid=,command= | GUARD_PATTERN="--user-data-dir=$UDD" awk '
		{ pid = $1; ppid = $2; parent[pid] = ppid; if (index($0, ENVIRON["GUARD_PATTERN"]) > 0) { mine[pid] = 1 } }
		END {
			changed = 1
			while (changed) {
				changed = 0
				for (p in parent) { if (!(p in mine) && (parent[p] in mine)) { mine[p] = 1; changed = 1 } }
			}
			for (p in mine) { print p }
		}'
}

# "<pid> <megabytes> <command>" for the given PIDs, largest first.
footprints() {
	local pids="$1"
	if [[ "$(uname -s)" == "Darwin" ]]; then
		# `top` prints sizes like 512K, 1247M, 12G, sometimes with a trailing +/- change marker.
		top -l 1 -stats pid,mem,command 2>/dev/null | awk -v list="$pids" '
			BEGIN { n = split(list, a, " "); for (i = 1; i <= n; i++) { want[a[i]] = 1 } }
			$1 in want {
				size = $2; sub(/[+-]$/, "", size)
				unit = substr(size, length(size)); value = substr(size, 1, length(size) - 1) + 0
				if (unit == "K") { mb = value / 1024 } else if (unit == "M") { mb = value } else if (unit == "G") { mb = value * 1024 } else { mb = size / 1048576 }
				cmd = $3; for (i = 4; i <= NF; i++) { cmd = cmd " " $i }
				printf "%s %.0f %s\n", $1, mb, cmd
			}' | sort -k2 -nr
	else
		# shellcheck disable=SC2086 # the PID list is meant to split into separate -p arguments
		ps -o pid=,rss=,comm= $(printf -- '-p %s ' $pids) 2>/dev/null | awk '{ printf "%s %.0f %s\n", $1, $2 / 1024, $3 }' | sort -k2 -nr
	fi
}

log "guard started: limit ${LIMIT_MB} MB, every ${INTERVAL}s, profile $UDD"
sample=0
while true; do
	pids="$(instance_pids | tr '\n' ' ')"
	if [[ -z "${pids// /}" ]]; then
		log "instance is gone, guard exits"
		exit 0
	fi
	rows="$(footprints "$pids")"
	total="$(printf '%s\n' "$rows" | awk '{ s += $2 } END { printf "%.0f", s }')"
	sample=$((sample + 1))
	if (( total > LIMIT_MB )); then
		log "LIMIT EXCEEDED: ${total} MB > ${LIMIT_MB} MB — quitting the instance. Largest processes:"
		printf '%s\n' "$rows" | head -n 10 | sed 's/^/    /' >>"$LOG"
		# Main processes first, gracefully: Electron quits on SIGTERM and takes its helpers along.
		for pid in $pids; do
			if ps -o command= -p "$pid" 2>/dev/null | grep -q -- "--user-data-dir=$UDD" && ! ps -o command= -p "$pid" | grep -q -- "--type="; then
				kill -TERM "$pid" 2>/dev/null
			fi
		done
		sleep 10
		leftover="$(instance_pids | tr '\n' ' ')"
		if [[ -n "${leftover// /}" ]]; then
			log "still running after 10s, killing: $leftover"
			kill -KILL $leftover 2>/dev/null
		fi
		exit 0
	fi
	if (( sample % REPORT_EVERY == 1 )) || (( total * 2 > LIMIT_MB )); then
		log "total ${total} MB; largest: $(printf '%s\n' "$rows" | head -n 3 | awk '{ printf "%s %s MB %s; ", $1, $2, $3 }')"
	fi
	sleep "$INTERVAL"
done
