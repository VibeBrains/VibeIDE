# Логотип VibeIDE — создание

← [Knowledge Index](../README.md)

Финальный логотип, AI-промпт для генерации, алгоритм вписывания в круг.

---

## [техника] Логотип VibeIDE — процесс создания и параметры

**Контекст:** долгий итеративный процесс создания лого в этой сессии.

**Суть:** Финальный логотип (`media/logo-final.png`) создан так:
1. **Генерация плоской версии**: AI генерирует лого на БЕЛОМ фоне, без glow, без теней (flat vector style). Ключ — "PURE WHITE background, NO dark areas anywhere, NO fills inside V arms".
2. **Удаление фона**: использовать внешний сервис (remove.bg или аналог) — алгоритмическое удаление даёт артефакты на нeonе. Сервис справляется чисто.
3. **Квадратный холст + safe zone**: скрипт Python находит bounding box контента, итерационно увеличивает холст пока контент не вписывается в круг (diameter = side), логотип центрируется.
4. **Neon glow**: per-channel gaussian blur без ручного определения цветовых зон. Каждый канал (R,G,B) размывается отдельно → цвет glow автоматически совпадает с цветом пикселя. Параметры: `radii=[30,12,4]`, `strengths=[1.0,1.5,2.2]`, brightening линий `+130` к каждому каналу.

Итоговый файл: 542×542 RGBA, все элементы внутри вписанного круга.

```python
# Ключевой алгоритм glow (per-channel):
def channel_glow(channel_data, alpha, radii, strengths):
    weighted = channel_data * alpha
    img = Image.fromarray(weighted.clip(0,255).astype(np.uint8), 'L')
    result = np.zeros_like(channel_data)
    for rad, s in zip(radii, strengths):
        bl = np.array(img.filter(ImageFilter.GaussianBlur(radius=rad)), dtype=float)
        result += bl * s
    return result
```

**Применение:** при повторном создании или доработке логотипа.

---

## [техника] Логотип — описание для AI генерации

**Контекст:** промпт для генерации плоской версии.

**Суть:** "VibeIDE logo. PURE WHITE background (#FFFFFF). FLAT style with NO glow, NO dark areas, NO shadows. Left arm of V: solid flat cyan #00CCDD outline only (no fill inside). Right arm: solid flat purple #8833DD outline only. Brain icon top center: flat cyan left half, flat purple right half. Circuit traces from arms. Code dashes inside left arm. `</>` at V bottom. 'VibeIDE' text: 'Vibe' solid cyan, 'IDE' solid magenta #DD00CC. Bottom rail: thin horizontal line with ECG pulse bumps, `{}` center. WHITE BACKGROUND. No grey. No dark. No shadows. 1024x1024."

**Применение:** при регенерации логотипа с нуля.

---

## [техника] Алгоритм вписывания лого в круг (safe zone)

**Контекст:** требование: лого не обрезается на платформах с crop в круг.

**Суть:**
```python
def fits_in_circle(logo_w, logo_h, canvas_size):
    cx = cy = canvas_size / 2
    radius = canvas_size / 2
    lx = (canvas_size - logo_w) / 2
    ly = (canvas_size - logo_h) / 2
    corners = [(lx,ly),(lx+logo_w,ly),(lx,ly+logo_h),(lx+logo_w,ly+logo_h)]
    for (px,py) in corners:
        if ((px-cx)**2+(py-cy)**2)**0.5 > radius:
            return False
    return True
# Итерируем: canvas_size += 10 пока не fits_in_circle
```
Холст начинается с ширины контента + padding, увеличивается по 10px до вписания. Лого центрируется на финальном холсте.

**Применение:** при подготовке любых иконок/аватаров для соцсетей/сайтов.
