#!/bin/bash
# Runs a PowerShell command in the VibeIDE Windows build VM through the UTM guest agent (as SYSTEM) and prints its output.
set -euo pipefail
CMD="$1"
osascript - "$CMD" <<'AS'
on run argv
  with timeout of 3600 seconds
    tell application "UTM"
      set vm to virtual machine "VibeIDE Windows"
      set p to execute of vm at "powershell.exe" with arguments {"-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " & (item 1 of argv)} with output capturing
      repeat 3500 times
        set r to get result of p
        if exited of r then exit repeat
        delay 1
      end repeat
      return (output text of r) & (error text of r)
    end tell
  end timeout
end run
AS
