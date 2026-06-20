---
name: resolve-merge-conflicts
description: Разрешение Git-конфликтов через компактные выжимки (хвосты ours/base/theirs и diff) вместо загрузки целых файлов в контекст. Использовать, когда merge, rebase, cherry-pick или stash pop остановились на конфликтах, git status показывает unmerged paths или в файлах есть маркеры конфликтов.
vibeVersion: 1.1.0
---

# Разрешение merge-конфликтов

## Суть

Разрешать конфликты, **не открывая файлы целиком**, пока компактной выжимки достаточно. Сначала сводка по всем конфликтам, затем — по одному файлу за раз.

Скрипт-помощник лежит рядом со скиллом: `scripts/extract_conflict_context.py`. Примеры ниже предполагают установку скилла в `.vibe/skills/resolve-merge-conflicts/`; при другом расположении скорректировать путь.

## Порядок работы

1. **Сводка по всем конфликтам:**

```bash
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py
```

По сводке определить: какие файлы не разрешены, какие index-стадии существуют, сколько текстовых hunk'ов в каждом файле.

2. **Углубиться в один файл:**

```bash
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py --file path/to/file
```

Предпочитать это чтению файла целиком: скрипт печатает только ближайший контекст, секции `ours` / `base` / `theirs` каждого hunk'а и компактный unified diff между `ours` и `theirs`.

3. **Разрешить файл:**

- Взять одну сторону целиком, когда это уместно: `git checkout --ours -- path/to/file` или `git checkout --theirs -- path/to/file`.
- Иначе — отредактировать файл напрямую и убрать маркеры конфликта.
- Читать больше файла только если компактного вывода не хватает для верного решения.

4. **Перепроверить нерешённые:**

```bash
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py
git diff --name-only --diff-filter=U
```

5. **Валидация результата:**

- Не осталось unmerged paths.
- Не осталось маркеров `<<<<<<<`, `=======`, `>>>>>>>` в разрешённых файлах.
- Точечные тесты/сборка/линтер по затронутой области — зелёные.
- Разрешённые файлы добавлены в индекс (`git add` по файлам, не `git add .`).

## Команды скрипта

```bash
# Только сводка
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py

# Детально по одному файлу
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py --file path/to/file

# Детально по всем конфликтным файлам
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py --all

# JSON-вывод
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py --file path/to/file --json

# Настройка объёма вывода
python3 .vibe/skills/resolve-merge-conflicts/scripts/extract_conflict_context.py \
  --file path/to/file \
  --context 3 \
  --max-lines 60
```

## Замечания

- Скрипт — **до** открытия конфликтных файлов напрямую, не после.
- Разрешать по одному файлу за раз — контекст остаётся маленьким.
- Скрипт понимает и текстовые конфликты с маркерами, и index-only конфликты (add/add, modify/delete): для файла без маркеров в рабочем дереве он показывает превью index-стадий.
- Семантику выбора стороны сверять с целью merge: «наша ветка» (`ours`) при rebase меняется местами с «их» — при сомнении смотреть `git status` и понимать, что именно вливается куда.
