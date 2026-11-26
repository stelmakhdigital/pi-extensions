# Паттерны движения

Сниппеты рассчитаны на перенос без правок: имена токенов свои значения не несут, берать их из `DESIGN.md`.

## Motion-токены

```css
:root {
  --motion-instant: 80ms;      /* отклик на нажатие */
  --motion-fast: 150ms;        /* hover, focus, small state */
  --motion-base: 220ms;        /* раскрышка, панель */
  --motion-slow: 300ms;        /* модалка, вход экрана */
  --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);
}
```

Длительность задаётся по роли, а не по элементу: две кнопки с 150 и 260 мс читаются как баг.

## Состояние элемента

```css
.button {
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    transform var(--motion-instant) var(--ease-standard),
    box-shadow var(--motion-fast) var(--ease-standard);
}
.button:hover { transform: translateY(-1px); }
.button:active { transform: translateY(0) scale(0.98); transition-duration: var(--motion-instant); }
.button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
```

Отдельно `focus-visible`, а не `focus`: ring не должен появляться при клике по кнопке мыши.

## prefers-reduced-motion: не «выключить», а «без движения»

```css
@media (prefers-reduced-motion: reduce) {
  .card { transition: none; transform: none; }
  /* Контент обязан быть видимым: reveal-паттерн без этой строки оставляет пустой экран. */
  .reveal { opacity: 1; transform: none; }
  .spinner { animation-duration: 2s; }  /* индикатор оставляем, он сообщает о работе */
}
```

Тест, который ловит ошибочный вариант: поставить `prefers-reduced-motion: reduce` и прокрутить страницу — ни одного невидимого блока с текстом.

## Scroll reveal с fallback

```html
<div class="reveal">…</div>
```

```css
.reveal { opacity: 1; }
@media (prefers-reduced-motion: no-preference) {
  .reveal { opacity: 0; transform: translateY(12px); transition: opacity var(--motion-base), transform var(--motion-base) var(--ease-enter); }
  .reveal.is-in { opacity: 1; transform: none; }
}
```

```js
// Без JS и без поддержки IntersectionObserver контент остаётся видимым:
// класс навешивается сверху, отсутствие скрипта не прячет секцию.
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("is-in"), io.unobserve(e.target))),
  { rootMargin: "0px 0px -10% 0px" }
);
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
```

## Переход между состояниями: View Transitions

```js
function navigate(url) {
  if (!document.startViewTransition) { location.href = url; return; }   // fallback обязателен
  document.startViewTransition(async () => {
    const html = await (await fetch(url)).text();
    document.documentElement.innerHTML = new DOMParser().parseFromString(html, "text/html").documentElement.innerHTML;
  });
}
```

```css
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 220ms; }
@media (prefers-reduced-motion: reduce) { ::view-transition-group(*) { animation: none; } }
```

## Список с входом и выходом

```jsx
// motion: один stagger на однородный ряд, не на разные секции
<motion.ul layout>
  <AnimatePresence initial={false}>
    {items.map((item, i) => (
      <motion.li
        key={item.id}
        layout
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.22, delay: Math.min(i, 8) * 0.03, ease: [0.16, 1, 0.3, 1] }}
      >
        {item.label}
      </motion.li>
    ))}
  </AnimatePresence>
</motion.ul>
```

`height: auto` здесь осознанное исключение из «двигать только transform»: без него список прыгает. Стаггер ограничен восемью элементами, иначе длинный ряд входит две секунды.

## Частые поломки

| Симптом | Причина |
|---|---|
| Дёргается при hover | `transition: all` тянет размеры; или анимируется `width`/`height` |
| Проскрутка проседает на списке | анимация вызывается на каждый кадр скролла; нужен `IntersectionObserver` или `scroll-timeline` |
| После анимации элемент «не на месте» | конечное состояние не совпало с обычным стилем: анимация должна приводить к тому же значению, что и без неё |
| Текст пропал | reveal с `opacity: 0` и `prefers-reduced-motion` без строки-отмены |
| Сдвиг макета при загрузке (CLS) | скелетон меньше итогового контента или шрифт подменяется без `size-adjust` |
| Пузырь анимации поверх модалки | `z-index` анимируемого слоя; смотреть раздел про слои у `ui-review` |
