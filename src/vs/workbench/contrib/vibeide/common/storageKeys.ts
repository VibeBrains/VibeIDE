/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// past values:
// 'vibe.settingsServiceStorage'
// 'vibe.settingsServiceStorageI' // 1.0.2

// 1.0.3 (VibeIDE)
export const VOID_SETTINGS_STORAGE_KEY = 'vibeide.settingsServiceStorageII';


// past values:
// 'vibe.chatThreadStorage'
// 'vibe.chatThreadStorageI' // 1.0.2

// 1.0.3 (VibeIDE)
export const THREAD_STORAGE_KEY = 'vibeide.chatThreadStorageII';

// Open chat tabs (refactor B): the working set of threads shown as in-view tabs above the chat.
// WORKSPACE-scoped so each project keeps its own open tabs (mirrors the old per-workspace editor layout).
export const OPEN_TAB_IDS_KEY = 'vibeide.chatOpenTabIds';



export const OPT_OUT_KEY = 'vibeide.app.optOutAll';

// Config-providers cache: the last successfully merged providers.json entry set (global ~/.vibe +
// workspace .vibe, secrets never included). Restored synchronously at startup so config providers
// are usable BEFORE the async file reads land (and in windows with no folder open); every reload
// overwrites it, so entries deleted from the files reconcile away instead of lingering as ghosts.
export const VIBE_CONFIG_PROVIDERS_CACHE_KEY = 'vibeide.configProvidersCacheI';

// Вырезанные встроенные провайдеры (OpenCode Go, Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Pollinations, Vertex, Azure,
// Bedrock, «Совместимо с OpenAI API») переехали к провайдерам из файлов общего набора, и настройки человека переехали вместе
// с ними. Перенос идёт при чтении настроек, когда окна для уведомления ещё нет, поэтому отчёт ждёт в хранилище, пока
// уведомление не показано. Значение — JSON `ProviderMigrationReport`; после показа ключ удаляется.
export const PROVIDER_MIGRATION_NOTICE_KEY = 'vibeide.migration.providersNotice';

// Файлы провайдеров, которых нет в наборе и которые надо создать при переносе (`MIGRATED_PROVIDER_FILES`).
// Значение — JSON-массив id; запись удаляется, когда файл создан или уже существует.
export const PROVIDER_FILES_MIGRATION_KEY = 'vibeide.migration.providerFiles';

// Ключ уведомления прежнего вида — только об OpenCode Go. Новое уведомление его заменило, ключ при старте убирается.
export const LEGACY_OPENCODE_GO_NOTICE_KEY = 'vibeide.migration.openCodeGoNotice';

// Свёрнутость блока «Свои провайдеры» в настройках: булево значение, `true` — свёрнут; запоминается между запусками.
export const CUSTOM_PROVIDERS_COLLAPSED_KEY = 'vibeide.settings.customProvidersCollapsed';
