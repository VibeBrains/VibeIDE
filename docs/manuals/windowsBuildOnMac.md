# Сборка Windows-артефактов на маке

Установщик `VibeIDESetup.exe` и портативный архив `win32-x64` собираются в виртуальной машине Windows 11 ARM64 под UTM.
Сам macOS их собрать не может: нативные модули (`node-pty`, `sqlite3`, `spdlog`, `windows-*`) компилирует только MSVC.

Сценарии — `scripts/win-vm/`. Стенд — `/Volumes/Storage/Caches/vibeide/windows/`.

## Что где лежит

- `VibeIDE Windows.utm` — виртуальная машина: 6 ядер, 10 ГБ памяти, диск 63 ГБ
- `ssh/` — ключ для входа администратором `vsadmin`
- `artifacts/<версия>/` — собранные артефакты и эталон прошлого релиза для сверки
- В машине: `C:\b\VibeIDE` — клон репозитория, `C:\dl` — скачанные установщики

## Сборка релиза

1. Запустить машину и дождаться сети:
   ```bash
   /Applications/UTM.app/Contents/MacOS/utmctl start "VibeIDE Windows"
   scripts/win-vm/vssh.sh 'hostname'
   ```
   Адрес машины — `192.168.64.5`; сменился — узнать через `scripts/win-vm/gexec.sh` и передать в `VM_IP`.
2. Скопировать сценарии и собрать опубликованный тег.
   Сборка идёт вне сеанса SSH: `launch-build.ps1` запускает `build.ps1` через CIM под `pwsh` 7, иначе обрыв соединения убивает сборку.
   ```bash
   scp -i /Volumes/Storage/Caches/vibeide/windows/ssh/id_ed25519 scripts/win-vm/{build.ps1,package.ps1,crossDeps.mts} /Volumes/Storage/Caches/vibeide/release/launch-build.ps1 vsadmin@192.168.64.5:C:/
   scripts/win-vm/vssh.sh 'powershell -ExecutionPolicy Bypass -File C:\launch-build.ps1 -Tag vX.Y.Z'
   ```
   Ход сборки — в `C:\b\build.log`.
   `build.ps1` клонирует тег, ставит зависимости, выравнивает платформенные пакеты и запускает
   `release-windows.ps1 -SkipPublish`. Версия не бампается: собирается то, что в теге.
3. Упаковку без перекомпиляции повторяет `package.ps1`.
   Если сборка упала на `fetch failed` при загрузке встроенных расширений, open-vsx.org недоступен:
   перенести с мака готовую копию и запустить `package.ps1`:
   ```bash
   scp -r -i /Volumes/Storage/Caches/vibeide/windows/ssh/id_ed25519 .build/builtInExtensions vsadmin@192.168.64.5:C:/b/VibeIDE/.build/
   ```
4. Забрать артефакты из `C:\b\VibeIDE\.build\win32-x64\{system-setup,archive}` через `scp`.
5. Сверить с эталоном прошлого релиза: состав бинарников и архитектура каждого `.node`, `.exe`, `.dll`.
   Смена архитектуры или пропавший платформенный пакет — дефект сборки, не выкладывать.
6. Загрузить в релиз тега с мака и дописать Windows в «📦 Сборка»:
   ```bash
   gh release upload vX.Y.Z -R VibeBrains/VibeIDE VibeIDESetup.exe VibeIDE-X.Y.Z-win32-x64.zip
   ```
   `uploads.github.com` бывает недоступен часами: при `dial tcp … i/o timeout` повторять, пока не откроется окно доступности.
   Размер каждого файла после загрузки сверить с локальным (`gh release view vX.Y.Z --json assets`).
7. Открыть PR в winget — с мака, после загрузки `.exe`:
   ```bash
   scripts/win-vm/wingetPr.sh --dry-run   # только отрендерить манифесты и посмотреть
   scripts/win-vm/wingetPr.sh             # ветка в форке winget-pkgs и PR
   ```
   Скрипт берёт хеш опубликованного файла, рендерит шаблоны `build/winget/` и кладёт три файла в форк через API.
   `winget validate` он не запускает: галочка в чеклисте PR остаётся пустой, манифест проверяет конвейер winget-pkgs.
8. Погасить машину: `utmctl stop "VibeIDE Windows"` — она держит 10 ГБ памяти.

## Новый стенд с нуля

Клонировать любую Windows 11 ARM64 под UTM с включённым TPM и сервером OpenSSH, затем выполнить в ней `tools.ps1`.
Он ставит Git, Node x64 (запасной), Python, PowerShell 7 и VS 2022 Build Tools: C++ x64 и ARM64, Spectre-библиотеки, Windows SDK.
После установки Build Tools нужна перезагрузка (код 3010).

## Чего стенд не делает

- Не подписывает установщик: сертификата нет, SmartScreen покажет «неизвестный издатель»
- Не публикует: `gh` в машине не настроен, загрузка идёт с мака
- `winget validate` не запускает: winget стартует только в сеансе рабочего стола Windows, из SSH он недоступен
