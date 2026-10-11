#!/bin/bash
# ssh to the VibeIDE Windows build VM as the admin (see docs/manuals/windowsBuildOnMac.md): vssh.sh '<powershell command>'
W=/Volumes/Storage/Caches/vibeide/windows
exec ssh -i $W/ssh/id_ed25519 -o UserKnownHostsFile=$W/ssh/known_hosts -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 "vsadmin@${VM_IP:-192.168.64.5}" "powershell -NoProfile -Command \"[Console]::OutputEncoding=[Text.Encoding]::UTF8; $1\""
