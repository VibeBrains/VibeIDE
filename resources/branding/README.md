# Брендинг VibeIDE — мастера иконок

Единый источник правды для иконок приложения — векторные мастера в этой папке.
Все растровые файлы собираются из них; вручную растр не правится.

| Файл | Что это |
|---|---|
| `vibeide-logo.svg` | Логотип-мозг, вектор, прозрачный фон — исходник для всех платформ |
| `vibeide-logo-small.svg` | Тот же логотип с утолщёнными линиями — для размеров 32 px и меньше |
| `vibeide-macos-icon.svg` | Маковская иконка: логотип на графитовом сквиркле 824/1024 по шаблону Apple |
| `vibeide-logo-1024.png`, `vibeide-macos-icon-1024.png` | Готовые растры 1024 px из мастеров выше |

## Регенерация

Нужны `rsvg-convert` (`brew install librsvg`) и `iconutil` (macOS).
Для 32 px и меньше берётся `-small` вариант: на мелких размерах обычные линии сливаются.

- **macOS `resources/darwin/code.icns`**: iconset 16–512 + @2x из `vibeide-macos-icon.svg`
  (`rsvg-convert` из папки `branding`, чтобы нашлась ссылка на логотип) → `iconutil -c icns`
- **Windows `resources/win32/code.ico`**: PNG 16/24/32/48/64/128/256 из логотипа, упакованные в ICO
  (PNG-записи, без маски); плитки `code_150x150.png`, `code_70x70.png` — тем же логотипом
- **Linux `resources/linux/code.png`**: 512 px из логотипа
- **Внутри IDE**: `src/vs/workbench/browser/media/vibeide-icon.png` (256), `void-icon-sm.png` (128),
  `media/icon-final-soft.png` (256, README и сторонние скрипты)

Windows подхватывает новый `code.ico` при следующей сборке: rcedit вшивает его в exe.
