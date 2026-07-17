# Просмотр видео в чате (/watch): пайплайн yt-dlp → ffmpeg → vision

← [Knowledge Index](../README.md)

---

## [архитектура] Кадры по сменам сцен + транскрипт → один vision-запрос

**Контекст:** фича `/watch` (2026-07-17, ветка `next`): пользователь даёт ссылку/путь на видео, модель «смотрит» его целиком. Источник идеи — публичный рецепт скилла watch для Claude Code (yt-dlp + ffmpeg scene detection + Whisper); у нас Whisper заменён на уже живущий в IDE локальный STT (GigaAM), а пайплайн встроен в чат как первая по-настоящему перехватываемая slash-команда.

**Суть.** Слои повторяют рецепт голосового ввода ([[localSttSherpaOnnx]]):

- `common/video/` — контракты (`vibeVideoTypes.ts`), каталог бинарей с SHA256 (`vibeVideoTools.ts`, зеркало-релиз `video-tools-v1`: yt-dlp 2026.07.04 + ffmpeg-static b6.0 на 4 платформы), настройки `vibeide.video.*`. Чистые модули, юнит-тесты в `test/common/video/`.
- `electron-main/video/vibeVideoMainService.ts` — докачка инструментов при первом использовании (общий хелпер `electron-main/vibeVerifiedDownload.ts`, вынесен из voice) и пайплайн **дочерними процессами** (`child_process.spawn`): probe (`yt-dlp --dump-single-json`) → субтитры (`--write-subs --write-auto-subs --convert-subs srt`) → видео ≤`frameHeight`p → кадры (`ffmpeg select='eq(n,0)+gt(scene,T)',scale,showinfo -fps_mode vfr`) → при отсутствии субтитров звук в raw PCM16 16 кГц. **UtilityProcess не нужен**: внешний CLI и так не роняет IDE — воркер оправдан только для синхронных N-API аддонов вроде sherpa.
- `electron-browser/video/vibeVideoChatService.ts` — оркестратор `/watch`: vision-гейт ДО пайплайна (`isModelVisionCapable`), consent-модалка на инструменты, прогресс с отменой, STT-fallback через фасад voice, кадры → `ChatImageAttachment[]` → `addUserMessageAndStreamResponse({ images, displayContent })`. Канальный клиент — **единственная вечная подписка listen** (ловушка `ChannelClient#requestEvent`, см. [[localSttSherpaOnnx]]).
- STT-fallback: новый session-less запрос `decodeBatch` в voice-воркере; нарезка на чанки ≤28 с (= `MAX_SEGMENT_SECONDS` воркера) живёт в `VibeVoiceMainService.transcribePcm16`, и вся работа считается одной busy-периодой idle-shutdown (иначе `keepAliveSec: 0` убивал бы движок между чанками с перезагрузкой моделей на каждый чанк).

**Применение:** новый «тяжёлый внешний инструмент» в IDE = каталог в common (url/SHA256/размер) + `vibeVerifiedDownload` + consent-модалка + spawn из electron-main. Бинари НЕ бандлить: рантайм-загрузка снимает вопросы ASAR/dylib/подписи GPL-сборок.

## [квирк] yt-dlp игнорирует навязанный контейнер при мерже

**Контекст:** сухой прогон 2026-07-17: `yt-dlp -f "bv*+ba" -o video.mp4` на ролике с webm-дорожками.

**Суть:** при мерже видео+аудио yt-dlp выбирает контейнер сам — получился файл `video.mp4.webm`, и «фиксированный» путь протух. ffmpeg при этом читает любой контейнер.

**Применение:** всегда `-o "video.%(ext)s"` и поиск результата глобом/префиксом `video.*`; расширение не хардкодить.

## [квирк] Однокадровое видео даёт ноль кадров при обычном пороге сцен

**Контекст:** тот же прогон: статичный talking-head ролик, `select='gt(scene,0.3)'` → ноль кадров; 0.1 → один кадр.

**Суть:** scene detection меряет разницу кадров — статичный скринкаст/говорящая голова может не пробить даже низкий порог. Без якоря пайплайн возвращает пустоту и vision-запрос не из чего собирать.

**Применение:** в фильтр всегда добавлять якорь первого кадра `eq(n,0)+…`; при < 3 кадров — один автоповтор с порогом 0.1 (`RETRY_SCENE_THRESHOLD` в `vibeVideoMainService.ts`).

## [правило] yt-dlp протухает — это норма жизни, а не инцидент

**Контекст:** YouTube регулярно ломает экстракторы; захардкоженный SHA256-каталог по образцу voice-моделей конфликтует с потребностью частых обновлений инструмента.

**Суть:** SHA256 зеркала гарантирует только первую установку. Дальше — самообновление: standalone-бинарь yt-dlp умеет `yt-dlp -U`; канал отдаёт команду `updateYtDlp`, а renderer вешает кнопку «Обновить yt-dlp» прямо на уведомление об ошибке скачивания (`reportPipelineError`, эвристика по подстроке `yt-dlp` в сообщении).

**Применение:** при жалобе «/watch не качает с YouTube» — сначала кнопка обновления, потом отладка. При выпуске `video-tools-v2` — новая версионная папка (`VIDEO_TOOLS_DIR`), не перезапись v1.

**Связано:** [[localSttSherpaOnnx]] — рецепт слоёв, ловушка listen, consent-модалка; `docs/knowledge/architecture/layerSplitElectronBrowser.md` — куда класть desktop-реализации фасадов.
