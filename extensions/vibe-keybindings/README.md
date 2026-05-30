# Vibe Keybindings (IntelliJ IDEA / JetBrains style)

Built-in keymap for VibeIDE that maps the **JetBrains / IntelliJ IDEA default
shortcut scheme** (IntelliJ Ultimate, WebStorm, PyCharm, PhpStorm, …) onto
VibeIDE commands.

## What this is

Keybindings-only. The extension contributes `contributes.keybindings` and ships
**no runtime code** (no commands, no activation, no dependencies). The build
discovers it automatically via `extensions/*/package.json`.

## Provenance

This keymap is authored for VibeIDE against the **public JetBrains default
keymap** (the JetBrains keyboard-shortcut scheme) mapped to VibeIDE/VS Code
command IDs and standard `when` contexts. The JetBrains shortcut scheme and the
command IDs are functional facts, not third-party authorship; this file is **not**
a port of any third-party extension and carries no foreign copyright.

The `when` clauses follow the VS Code default-keybinding conventions. Word-motion
bindings use the standard cursor/delete-word commands (no extension-specific
"camel humps" toggle).

## Maintaining

Edit `package.json` directly — this is VibeIDE's own keymap, there is no upstream
to re-sync from. When the JetBrains scheme or VibeIDE command IDs change, adjust
the affected entries here. See
[`docs/knowledge/build/vibe-keybindings.md`](../../docs/knowledge/build/vibe-keybindings.md).

## License

MIT — see [LICENSE.txt](./LICENSE.txt). © VibeIDE Team.
