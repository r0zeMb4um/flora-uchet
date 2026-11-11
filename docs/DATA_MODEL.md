# Модель данных — листы Google Таблицы (этап 1)

Один лист = одна таблица. Первая строка — заголовки (имена ниже, латиницей для кода). На этапе 2 эти листы переносятся в таблицы базы данных один к одному, поэтому имена колонок не менять без причины.

Общие правила:
- Все деньги — целые тенге (`int`). Проценты — сотые доли процента (`int`, 3% = 300).
- Все даты-время — ISO-строка в часовом поясе `Asia/Almaty` (`2026-11-06T21:14:00+05:00`). Дата смены — `YYYY-MM-DD`.
- ID — строки (UUID или короткие коды). `op_id` — UUID операции из Mini App/бота.
- В каждом листе есть `client_id`; в операционных — ещё `point_id`.
- Строки не удаляются. Исправление — новая обратная строка.
- **Факты и состояния** (решение D8 в `docs/DECISIONS.md`). Факты — деньги (`payments`, `cash_ops`), товар (`stock_moves`), долги (`debt_moves`) — только дописываются. Состояния — статусы в `receipts`, `shifts`, `reservations`, `invites`, количества в `stock_balance` и поля справочников (цены, `last_cost`, ставки, `active`, обезличивание) — обновляются на месте, но каждое изменение идёт отдельной операцией через `ops_log` и пишется в `audit`.
- **Формат ячеек.** `setup()` ставит всем колонкам с ID, датами, временем и Telegram ID текстовый формат (`@`), иначе Таблица сама превратит `2026-11-06` в дату, а `001` в число 1. Деньги и количества — числовой формат без дробей.

## Справочники

### `clients` — клиенты (ведёт администратор)
| Колонка | Тип | Пример |
| --- | --- | --- |
| client_id | str | c1 |
| name | str | Цветы у Айгуль |
| tariff | str | start / pro / pilot |
| paid_until | date | 2026-12-06 |
| timezone | str | Asia/Almaty |
| admin_finance_access | bool | TRUE — администратор видит финансы клиента; выключает только администратор (D16) |

### `points` — точки
| Колонка | Тип | Пример |
| --- | --- | --- |
| point_id | str | p1 |
| client_id | str | c1 |
| name | str | Точка 1 |
| address | str | (адрес ларька) |

### `settings` — настройки точки
| Колонка | Тип | Пример |
| --- | --- | --- |
| client_id, point_id | str | c1, p1 |
| change_fund | int ₸ | 5000 — размен, всегда лежит в кассе |
| expense_items | str | статьи постоянных расходов владелицы через «;»: Аренда;Коммуналка;Интернет (D11) |
| reminder_time | str | 22:00 |
| cash_tolerance | int ₸ | 0 |

### `catalog` — позиции (общие на клиента)
| Колонка | Тип | Пример |
| --- | --- | --- |
| item_id | str | i_rose_red_60 |
| client_id | str | c1 |
| code | str | R-RED-60 |
| category | enum | flowers / greens / toys / baskets / packaging |
| name | str | Роза красная 60 см |
| unit | str | шт |
| sale_price | int ₸ | 1200 (подсказка) |
| last_cost | int ₸ | 650 (обновляется при приходе) |
| min_stock | int шт | 20 |
| status | enum | active / review / hidden |
| created_by, created_at | str | staff_id, дата |

### `staff` — сотрудники
| Колонка | Тип | Пример |
| --- | --- | --- |
| staff_id | str | s_anna |
| client_id, point_id | str | c1, p1 |
| telegram_id | int | заполняется при первом входе по ссылке-приглашению |
| name | str | Анна |
| role | enum | florist / owner |
| shift_rate | int ₸ | 5000 |
| pct_bp | int | 300 (= 3%) |
| consent_at | datetime | время нажатия «Согласен» |
| consent_version | str | v1 |
| active | bool | TRUE |

### `customers` — покупатели (должники и предзаказы)
| Колонка | Тип | Пример |
| --- | --- | --- |
| customer_id | str | cu1 |
| client_id | str | c1 |
| name | str | Айгуль |
| note | str | соседний магазин |
| phone | str | ПУСТО на этапе 1 |
| phone_consent_at | datetime | ПУСТО на этапе 1 |
| anonymized | bool | FALSE |

Текущий долг покупателя не хранится, а считается: сумма `debt_moves` покупателя (только проведённые операции).

### `invites` — ссылки-приглашения
Владелица (или администратор) создаёт приглашение; ссылка `t.me/<бот>?start=<token>`. При первом входе по ней Telegram ID записывается в `staff`, приглашение гасится.

| Колонка | Тип | Пример |
| --- | --- | --- |
| token | str | случайная строка 24+ символа |
| client_id, point_id | str | c1, p1 |
| staff_id | str | s_anna — строка в `staff` заводится заранее с ролью, ставкой и % |
| expires_at | datetime | через 48 часов |
| status | enum | active / used / revoked |
| used_by_telegram_id | str | |

## Журналы

### `ops_log` — журнал операций (маркер проведения и защита от дублей)
| Колонка | Тип | Пример |
| --- | --- | --- |
| op_id | str (UUID) | уникальный |
| client_id, point_id, shift_id | str | |
| kind | enum | open_shift / sale / bouquet / preorder / reserve / reserve_cancel / preorder_assemble / preorder_pickup / income / defect / refund / cancel / debt_repay / debt_opening / stock_start / cash_out / withdrawal / inventory / close_shift / correction / pay_adjust / new_item / catalog_edit / staff_edit / settings_edit / invite_create / join / anonymize / owner_expense |
| actor_staff_id | str | s_anna |
| status | enum | pending / posted / failed |
| created_at, posted_at | datetime | |
| plan_json | str | план записи операции (что дописать, что поменять, прежние значения). Повтор `pending` применяет сохранённый план, а не строит новый |
| result_json | str | ответ, который вернули при проведении (для «уже проведено») |

Правило: строки операции в других листах пишутся с её `op_id`; `status=posted` ставится последним. Всё, что считает отчёты и остатки, учитывает только строки с `op_id`, у которого `ops_log.status = posted`.
Зависшие операции (решение D14): `pending` старше 1 часа ночной триггер переводит в `failed`; их строки нигде не учитываются, остатки затронутых позиций пересчитываются по журналу. Поиск `op_id` — через `TextFinder` по колонке, без чтения всего листа.

### `shifts` — смены
| Колонка | Тип | Пример (эталон) |
| --- | --- | --- |
| shift_id | str | sh214 |
| shift_no | int | 214 — номер смены на точке |
| client_id, point_id | str | |
| shift_date | date | 2026-11-06 |
| florist_ids | str (через запятую) | s_anna,s_mira |
| opened_at, closed_at | datetime | |
| prev_next_cash | int ₸ | 15000 — остаток, оставленный прошлой сменой |
| open_cash | int ₸ | 15000 — принято при открытии |
| open_diff | int ₸ | 0 = open_cash − prev_next_cash |
| calc_cash | int ₸ | 32500 |
| counted_cash | int ₸ | 32498 |
| cash_diff | int ₸ | −2 = counted − calc |
| payroll_total | int ₸ | 12038 — начислено |
| payroll_unpaid | int ₸ | 0 — к доплате, если наличных не хватило (D18) |
| close_withdrawal | int ₸ | 10000 |
| next_cash | int ₸ | 10460 = counted − payroll − close_withdrawal |
| status | enum | open / closed |

### `shift_staff` — флористы смены и их условия (решение D3)
Пишется при открытии смены (и при подключении второго флориста). Зарплата смены считается только по этим строкам, а не по текущему `staff`.

| Колонка | Тип | Пример (эталон) |
| --- | --- | --- |
| shift_id, op_id | str | sh214 |
| client_id, point_id | str | |
| staff_id | str | s_anna |
| shift_rate | int ₸ | 5000 — ставка на момент открытия |
| pct_bp | int | 300 — процент на момент открытия |

### `receipts` — чеки
| Колонка | Тип | Пример |
| --- | --- | --- |
| receipt_id, op_id | str | |
| receipt_no | int | номер чека в смене |
| client_id, point_id, shift_id | str | |
| type | enum | sale / bouquet / preorder |
| price | int ₸ | цена, введённая флористом |
| discount_kind | enum | none / amount / pct |
| discount_value | int | ₸ или сотые доли % |
| discount_amount | int ₸ | 600 |
| total | int ₸ | 5400 |
| debt_amount | int ₸ | часть итого, отданная в долг (0, если нет); такая же строка пишется в `debt_moves` |
| customer_id | str | для долга и предзаказа |
| pickup_date | date | для предзаказа |
| assembly_status | enum | — / waiting / assembled / picked_up |
| status | enum | posted / cancelled |
| reservation_id | str | если чек создан из брони |
| created_by | str | staff_id |

Строки состава (что вошло в чек) — в `stock_moves` с тем же `receipt_id`.
Итого чека всегда > 0 (решение D6).
Проверка при записи: оплаты по чеку + `debt_amount` + неоплаченный остаток предзаказа = `total`.
Неоплаченный остаток предзаказа = `total` − оплаты (`advance`, `topup`) − долг, оформленный при выдаче.

### `reservations` — брони без аванса (решение D5)
Бронь не входит в выручку. При первой оплате создаётся чек-предзаказ в текущей смене, бронь получает статус `converted` и ссылку на чек.

| Колонка | Тип | Пример |
| --- | --- | --- |
| reservation_id, op_id | str | |
| client_id, point_id, shift_id | str | смена, в которой оформили бронь |
| customer_id | str | cu2 |
| pickup_date | date | 2026-11-08 |
| price | int ₸ | 25000 |
| discount_kind, discount_value, discount_amount | | как в `receipts` |
| total | int ₸ | 25000 |
| status | enum | active / converted / cancelled |
| receipt_id | str | заполняется при первой оплате |
| created_by | str | staff_id |

### `debt_moves` — движение долгов (решение D4)
Единый журнал долгов: сколько каждый покупатель должен = сумма его строк. Деньги погашения при этом пишутся и в `payments` (они пришли в кассу).

| Колонка | Тип | Пример (эталон) |
| --- | --- | --- |
| debt_move_id, op_id | str | |
| client_id, point_id, shift_id | str | shift_id пуст для стартового долга |
| customer_id | str | |
| type | enum | opening (из тетради) / sale (продажа в долг) / pickup (остаток предзаказа при выдаче, D12) / repay (погашение) / cancel (отмена чека) |
| amount | int ₸ (со знаком) | +4500 Айгуль (sale), +3000 Ерлан (opening), −3000 Ерлан (repay) |
| receipt_id | str | для sale, pickup, cancel |
| since_date | date | для opening — дата долга по тетради (для «старше 30 дней») |
| comment | str | |

### `payments` — деньги по чекам и долгам
| Колонка | Тип | Пример |
| --- | --- | --- |
| payment_id, op_id | str | |
| client_id, point_id, shift_id | str | смена, в которую пришли/ушли деньги |
| receipt_id | str | пусто для погашения долга |
| customer_id | str | для погашения долга |
| kind | enum | sale / advance / topup / debt_repay / refund |
| method | enum | cash / card (card = любой безнал: Kaspi QR, перевод, терминал) |
| amount | int ₸ | всегда > 0; направление задаёт kind (refund — деньги из кассы) |

Продажа в долг не создаёт платёж — она пишется в `receipts.debt_amount` и `debt_moves`.
Возврат денег по чеку: сумма всех возвратов ≤ сумма, реально оплаченная по чеку (решение D13).

### `stock_moves` — движение товара
| Колонка | Тип | Пример |
| --- | --- | --- |
| move_id, op_id | str | |
| client_id, point_id, shift_id | str | |
| type | enum | start / income / sale / defect / replace / adjust / cancel (возврат на склад при отмене чека) |
| item_id | str | |
| qty | int (со знаком) | +50 / −7 |
| cost_sum | int ₸ | сумма по накладной за строку (только income) |
| supplier_or_reason | str | Флора-опт / завяли / gift (подарок, решение D6) |
| receipt_id | str | для sale и replace |

### `stock_balance` — текущие остатки (решение D2)
Быстрая копия суммы `stock_moves`. Обновляется внутри той же блокировки, что и операция, после записи движений и до отметки `posted`. При дописывании зависшей операции остатки её позиций не прибавляются второй раз, а пересчитываются по журналу. Ночной триггер сверяет всё с журналом; при расхождении — исправляет и пишет администратору, источник правды — журнал.

| Колонка | Тип | Пример |
| --- | --- | --- |
| client_id, point_id, item_id | str | c1, p1, rose_red_60 |
| qty | int | 74 |
| last_op_id | str | op_id последней операции, изменившей остаток |
| updated_at | datetime | |

### `cash_ops` — касса
| Колонка | Тип | Пример |
| --- | --- | --- |
| cash_id, op_id | str | |
| client_id, point_id, shift_id | str | |
| type | enum | delivery / other / rate / pct / pay_adjust / withdrawal_day / withdrawal_close (аренды нет — D11) |
| amount | int ₸ | > 0, всегда расход из кассы. До пересчёта (входят в расчёт кассы): delivery, other, withdrawal_day, pay_adjust. После пересчёта: rate, pct, withdrawal_close |
| staff_id | str | для rate, pct и pay_adjust (доплата ЗП после исправления, D7) |
| comment | str | |

### `owner_expenses` — постоянные расходы владелицы по месяцам (решение D11)
Вносит только владелица. Не касса: деньги платятся не из ларька. Вычитаются только в прибыли месяца.

| Колонка | Тип | Пример |
| --- | --- | --- |
| expense_id, op_id | str | |
| client_id, point_id | str | |
| month | str | 2026-11 |
| item | str | Аренда (статья из `settings.expense_items`) |
| amount | int ₸ | 120000; > 0, кроме строки-исправления (отрицательная) |
| comment | str | |
| created_by | str | staff_id владелицы |

Исправление — обратной строкой с отрицательной суммой и ссылкой на исправляемую в `comment`.

### `bouquet_templates` — шаблоны букетов (быстрая продажа)
Создаёт флорист смены или владелица («Сохранить как шаблон»), убирает владелица или автор. Лист появляется в таблице сам при первой записи.

| Колонка | Тип | Пример |
| --- | --- | --- |
| template_id, op_id | str | |
| client_id | str | c1 |
| name | str | Нежность |
| items_json | str (JSON) | [{"item_id":"rose_red_60","qty":7},{"item_id":"eucalyptus","qty":3}] |
| price | int ₸ | 15000 |
| status | enum | active / hidden |
| created_by | str | staff_id |

### `audit` — журнал действий
| Колонка | Тип |
| --- | --- |
| ts, actor_telegram_id, action, details_json | |

## Служебное хранилище (не листы)
| Где | Что | Зачем |
| --- | --- | --- |
| Script Properties | `BOT_TOKEN`, `WEBHOOK_KEY`, `ADMIN_CHAT_ID`, `SPREADSHEET_ID`, `DEPLOYMENT_ID` | Секреты и настройки, не в коде и не в git |
| Script Properties | `LAST_UPDATE_ID` | Защита от повторов Telegram: обновление с `update_id` ≤ сохранённого игнорируется (номера растут) |
| CacheService | каталог, остатки, настройки точки | Скорость: не перечитывать листы на каждый запрос. Кэш живёт до 6 часов и до 100 КБ на ключ; его можно потерять без вреда — он пересобирается из листов. После каждой записи кэш затронутых данных сбрасывается |

## Лист `summary` (только для владелицы)
Выручка, касса и прибыль по дням и месяцам. **Пишет скрипт** — при каждом закрытии смены и ночью (формулам Таблицы пришлось бы сверять каждую строку с `ops_log`, это медленно и легко ломается). Только просмотр.
