# Main↔Renderer config bridge через IPC + env-var (v0.12.4)

## Проблема

`vibeideGlobalSettingsConfiguration.ts` регистрирует настройку, например `vibeide.catalog.modelsDevCacheTtlHours`. Renderer-side код легко её читает через `IConfigurationService`. Но **electron-main** код (например `modelsDevCatalog.ts`) — это **отдельный процесс**, у которого:

- НЕТ доступа к `IConfigurationService` (тот живёт в workbench/renderer DI).
- НЕТ shared memory с renderer.
- `process.env` у main и renderer — **разные** копии.

## Решение — IPC bridge через env-var

Pattern, использованный для `modelsDevCacheTtlHours` в v0.12.4:

### Шаг 1 — main-side читает env-var fresh на каждом use

`modelsDevCatalog.ts:52-62`:

```typescript
const DEFAULT_DISK_CACHE_TTL_HOURS = 24;
const resolveDiskCacheTtlMs = (): number => {
    const raw = process.env.VIBEIDE_MODELS_DEV_CACHE_TTL_HOURS;
    if (!raw) return DEFAULT_DISK_CACHE_TTL_HOURS * 60 * 60 * 1000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISK_CACHE_TTL_HOURS * 60 * 60 * 1000;
    const clamped = Math.max(1, Math.min(720, parsed));
    return clamped * 60 * 60 * 1000;
};
```

Key: НЕТ module-level кеша значения. Each call перечитывает env → setting change применяется на следующем вызове.

### Шаг 2 — main IPC service expose setter

`modelsDevCatalogStatusMainService.ts`:

```typescript
export class ModelsDevCatalogStatusMainService {
    async getStatus(): Promise<ModelsDevCatalogStatus> { ... }

    async setDiskCacheTtlHours(hours: number): Promise<void> {
        process.env.VIBEIDE_MODELS_DEV_CACHE_TTL_HOURS = String(hours);
    }
}
```

### Шаг 3 — renderer service proxy

`common/modelsDevCatalogStatusService.ts`:

```typescript
export interface IModelsDevCatalogStatusService {
    getStatus(): Promise<ModelsDevCatalogStatus>;
    setDiskCacheTtlHours(hours: number): Promise<void>;  // new method
}

class ModelsDevCatalogStatusService implements IModelsDevCatalogStatusService {
    // ProxyChannel.toService<IModelsDevCatalogStatusService>(channel) maps both methods automatically
    setDiskCacheTtlHours(hours: number): Promise<void> {
        return this.proxy.setDiskCacheTtlHours(hours);
    }
}
```

### Шаг 4 — renderer contribution push-on-change

`browser/modelsDevCatalogStatusContribution.ts:32-48`:

```typescript
const pushTtl = () => {
    const hours = configurationService.getValue<number>('vibeide.catalog.modelsDevCacheTtlHours') ?? 24;
    void statusService.setDiskCacheTtlHours(hours).catch(() => { /* IPC down */ });
};
pushTtl();  // initial push on startup
this._register(configurationService.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('vibeide.catalog.modelsDevCacheTtlHours')) pushTtl();
}));
```

## Почему НЕ `IConfigurationService` напрямую в main

- `IConfigurationService` живёт в workbench DI graph (renderer).
- Делать сложный wire-up чтобы main мог субскрайбить config events — overkill для одного значения.
- Env-var indirection — известный pattern, легко документируется, минимум кода.

## Когда использовать этот pattern

✅ **Use** когда:
- Main-process код имеет настройку.
- Значение редко меняется (env-var read на каждом use OK по cost).
- Нет sensitivity ко времени применения (next-call latency acceptable).

❌ **Don't use** когда:
- High-frequency lookup (env-var read на hot path = ОК, но не если миллион раз в секунду).
- Sensitive data (env vars видны через `process.env` всему main-process).
- Нужны events «settings changed» в main (env-var нет push-механизма; нужен полноценный IPC channel).

## Alternative — direct IPC method per setting

Если в будущем понадобится 10+ settings прокинутых в main:
- Один IPC method `pushSettings(settings: Record<string, unknown>)`.
- Main кеширует in-memory map, readers ищут по key.
- Renderer contribution слушает все relevant config changes и push'ит batch.

Текущая env-var indirection — OK для одного-двух settings. При росте — refactor.
