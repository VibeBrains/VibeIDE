# Vibe Neon

Default dark theme for **VibeIDE**. Bundled as `vibeide.vibeide-neon` with settings ids `vibe-neon` and `vibe-neon-noglow` (**Vibe Neon (No editor glow)** in the picker).

## Recommended theme

VibeIDE recommends **Vibe Neon**. Pick it with **Preferences: Color Theme** (`workbench.action.selectTheme`).

## Product default vs your settings

The workbench registers **default** values for `workbench.colorTheme` and `workbench.preferredDarkColorTheme` in `src/vs/workbench/services/themes/common/themeConfiguration.ts` (`ThemeSettingDefaults.VIBEIDE_DEFAULT_THEME` → `vibe-neon` on desktop). The extension also lists the same keys under **`contributes.configurationDefaults`** in this folder's `package.json`.

If **User**, **Workspace**, or **Folder** settings (or Settings Sync) already contain `workbench.colorTheme`, that **stored** value wins — same as in VS Code. To use Vibe Neon, set `"workbench.colorTheme": "vibe-neon"` in settings or choose **Vibe Neon** in the theme picker.
