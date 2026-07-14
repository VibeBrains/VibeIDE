# Примеры провайдеров — `.vibe/providers/`

Библиотека готовых конфигов LLM-провайдеров (по файлу на провайдера). Это **примеры для копирования**, не автозагружаемые конфиги: VibeIDE читает только `.vibe/providers.json`.

**Как применить:**
- скопируйте содержимое нужного файла в `.vibe/providers.json` (если файла нет — создайте), **или**
- перенесите объект провайдера из `providers[]` примера в свой существующий массив `providers` в `.vibe/providers.json`.

Каждый файл — валидный самодостаточный `providers.json` (JSONC: можно `//`-комментарии).

**Ключи API в файле не хранятся** — только `apiKeyEnv` (переменная окружения / `.vibe/.env`) или `apiKeyRef` (защищённые настройки). После структурных правок (id/baseURL/модели) перезапустите VibeIDE.

Полная спецификация формата — [`docs/manuals/providersSpec.md`](https://github.com/VibeIDETeam/VibeIDE/blob/main/docs/manuals/providersSpec.md). Общий пример со всеми рецептами — `.vibe/providers.example.jsonc`.
