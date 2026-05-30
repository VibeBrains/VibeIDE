# Vibe Keybindings (IntelliJ IDEA / JetBrains)

Built-in keymap for VibeIDE that maps IntelliJ IDEA / JetBrains keyboard shortcuts
(IntelliJ Ultimate, WebStorm, PyCharm, PhpStorm, …) onto VibeIDE commands.

## What this is

Keybindings-only. The extension contributes `contributes.keybindings` (219 entries)
and ships **no runtime code**. The upstream project's optional "Import IntelliJ
Keybindings (XML)" command is intentionally **not** bundled here.

## Source & updates

Ported from **[kasecato/vscode-intellij-idea-keybindings](https://github.com/kasecato/vscode-intellij-idea-keybindings)** (MIT, branch `master`).

To update, re-sync from that upstream (and re-apply the VibeIDE rebrand) — the
full procedure is documented in
[`docs/knowledge/build/vibe-keybindings.md`](../../docs/knowledge/build/vibe-keybindings.md).
Do not hand-edit the keybindings here; manual edits get clobbered on the next re-sync.

One upstream entry (`intellij.openInOppositeGroup`) is dropped: it has no key binding
and targets a runtime-only command that this keybindings-only build does not provide.

## License

MIT — see [LICENSE.md](./LICENSE.md). Original copyright © Keisuke Kato.
