# Движение

Читать этот файл, когда экран получает переходы, отклик на действия или починку дёрганья. Визуальный язык и токены — в `SKILL.md` рядом, проверка готового экрана — в `../ui-review/SKILL.md`.

Движение — обратная связь, а не украшение. Правило отбора одно: у каждого движения есть ответ на вопрос «что пользователь узнаёт от того, что элемент двигается». Ответа нет — движения нет.

## Шаг 1 — токены и сколько движения нужно

Если в проекте есть `DESIGN.md`, брать длительности, easing и правила движения из него. Если движения в проекте ещё нет, а задача его добавляет — дописать блок в `DESIGN.md` до кода, иначе через экран токены поедут.

Один блок в ответ, по нему и строить:

```
Плотность:      нет | только отклик на действие | переходы между экранами | выразительная хореография
Триггеры:       hover | focus | press | вход/выход | скролл | смена данных
Носитель:       CSS | View Transitions | библиотека
```

Плотность выбирается по продукту, а не по вкусу: у панели инструментов и у редактора промптов разный аппетит к движению. «Только отклик на действие» — нормальный ответ для половины интерфейсов.

## Шаг 2 — носитель

| Задача | Чем | Почему |
|---|---|---|
| Состояние элемента (hover, focus, press, раскрышка) | CSS `transition` по конкретным свойствам | Дёшево, работает без JS, снимается медиазапросом |
| Переход между экранами/состояниями с общим элементом | View Transitions API | Один вызов, браузер снимает старое состояние |
| Жёсткая хореография: последовательности, spring, жесты, общий shared element между роутами | библиотека (`motion`, `framer-motion`) | Без неё это ручной тайминг на десятках элементов |
| Движение, зависящее от позиции скролла или размера | CSS-анимация со `scroll-timeline` где поддержано, иначе `IntersectionObserver` с явным fallback | `scroll`-слушатель с чтением `getBoundingClientRect` в кадре — источник тормозов |

Библиотеку не тянуть ради трёх transition. Если тянем — называть, какие три момента её окупают.

## Шаг 3 — обязательное

- Двигать только `transform` и `opacity`. `width`, `height`, `top`, `margin` и `padding` в анимации значат пересчёт макета в каждый кадр.
- Длительность по роли, а не по элементу: отклик на нажатие 80-140 мс, состояние элемента 150-250 мс, вход панели или модалки 200-320 мс, уход чуть быстрее входа. Свыше ~400 мс интерфейс кажется медленным. Две кнопки с 150 и 260 мс читаются как баг.
- Нелинейный easing: вход `cubic-bezier(0.16, 1, 0.3, 1)`, уход и отклик — обычное `ease-out`. `linear` только для бесконечных индикаторов.
- `transition: <конкретные свойства>`; `transition: all` ловит в себя размеры и цвета и стоит кадров. Это же ловит `lint-ui.mjs`.
- `will-change` только на слое, который двигается прямо сейчас, и снимается после. Постоянный `will-change` на десятках узлов ест память.
- `prefers-reduced-motion` — не «выключить всё»: контент обязан оставаться видимым. Паттерн «`opacity: 0` + scroll reveal» без медиазапроса оставляет пустой экран у человека с вестибулярным расстройством. Оставлять мгновенный переход в конечное состояние.
- Один сыгранный момент вместо десяти мелких: последовательность на вход экрана стоит дороже, чем дрожание каждой карточки. Стаггер — на однородный ряд, не на разные секции.
- Скелетон обязан сохранять размеры итогового контента, иначе движение порождает CLS: `perf.mjs` и `a11y.mjs` покажут это как сдвиг макета.

## Сниппеты

Имена токенов в них — свои значения не несут, брать из `DESIGN.md`.

### Motion-токены

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

### Состояние элемента

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

### prefers-reduced-motion: не «выключить», а «без движения»

```css
@media (prefers-reduced-motion: reduce) {
  .card { transition: none; transform: none; }
  /* Контент обязан быть видимым: reveal-паттерн без этой строки оставляет пустой экран. */
  .reveal { opacity: 1; transform: none; }
  .spinner { animation-duration: 2s; }  /* индикатор оставляем, он сообщает о работе */
}
```

Тест, который ловит ошибочный вариант: поставить `prefers-reduced-motion: reduce` и прокрутить страницу — ни одного невидимого блока с текстом.

### Scroll reveal с fallback

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

### Переход между состояниями: View Transitions

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

### Список с входом и выходом

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
| Пузырь анимации поверх модалки | `z-index` анимируемого слоя; смотреть `../ui-review/references/checklist.md` |

## Шаг 4 — проверка в движении

Движение проверяется в движении, а не по коду. Браузерные скрипты — в скилле `ui-review` (`../ui-review/SKILL.md`, каталог `scripts/`):

- `perf.mjs <url> --click "<триггер>" --wait 800` — `INP` и `TBT` на реальном действии. `INP > 200 мс` после hover-анимации означает, что анимация блокирует основной поток.
- `a11y.mjs <url> --out DIR` — разделы про `transition: all`, `will-change`, `prefers-reduced-motion` и сдвиги макета; `--reduced-motion` отдельно проверяет, что контент остался видимым; скриншоты до/после с `--baseline` ловят случай, когда анимация оставила элемент в чужом положении.
- Вручную остаётся проверить прокрутку: `a11y.mjs <url> --reduced-motion --out DIR` смотрит только первый вьюпорт и валит прогон, если там остался текст с `opacity: 0`; ниже по странице reveal проверяется глазами или прогоном с `--click`, который доводит до блока.
- Счётчики: одна хореография на вход экрана, один marquee на страницу, ни одной анимации, которая повторяется чаще раза в 5 секунд без команды пользователя.

## Отчёт

Что двигается и зачем (одна строка на момент), чем реализовано, что происходит при `prefers-reduced-motion`, числа `INP`/`TBT` до и после. Без замера «до» правка не делается: «стало отзывчивее» без числа не утверждение.
