# Трекінг: Meta Pixel + Conversions API

Воронка: стаття `/list1` → Telegram-бот (SendPulse) → лід → продаж. Кожна подія йде в Meta з максимумом параметрів.

## Railway → Variables

| Змінна | Обов'язково | Що це |
|---|---|---|
| `META_PIXEL_ID` | так | ID пікселя / датасету |
| `META_CAPI_TOKEN` | так | токен Conversions API (системний користувач або Events Manager) |
| `BOT_USERNAME` | так | юзернейм бота без `@` |
| `WEBHOOK_SECRET` | так | будь-який довгий рядок; SendPulse і платіжка шлють його в заголовку `X-Secret` (або `?secret=`) |
| `REDIS_URL` | так на проді | Railway → New → Database → Redis, змінна підставиться сама. Без Redis сесії губляться при рестарті |
| `LEAD_VALUE` | бажано | цінність ліда для `Lead.value` (середній чек × конверсія ліда в оплату) |
| `CURRENCY` | ні | за замовчуванням `UAH` |
| `META_TEST_EVENT_CODE` | тільки на тест | код з Events Manager → Тестові події. Прибрати після перевірки |

Перевірка: `https://pilgrimagency.pro/health`.

## Події

| Крок | Подія | Звідки |
|---|---|---|
| Відкрив сторінку | PageView | піксель + сервер (один eventID) |
| Змінив цифри в калькуляторі | ViewContent `commission_calculator` | піксель + сервер |
| Клік на кнопку Telegram | Contact (+ `btn`: mid1 / final / sticky / footer) | піксель + сервер |
| /start у боті | CompleteRegistration | SendPulse → `/f1/bot-start` |
| Подивився відео (опц.) | ViewContent `hvco_video` | SendPulse → `/f1/video` |
| Заявка / «Написати Антону» | Lead (`lead_type`: form / dm) | SendPulse → `/f1/lead` |
| Надіслали посилання на оплату (опц.) | InitiateCheckout | SendPulse / CRM → `/f1/checkout` |
| Оплата | Purchase (сума, телефон, пошта) | платіжка / CRM / SendPulse → `/f1/purchase` |

### Що передається
- **user_data:** em, ph, fn, ln (SHA-256), external_id (`_vid` + `tg_<id>`), IP, user agent, `_fbc`, `_fbp`; ct / country, якщо сайт за Cloudflare.
- **Кукі:** `_vid` (400 днів), `_fbp`, `_fbc` (90 днів). Їх виставляє сервер, тому в Safari вони живуть довше, ніж JS-кукі.
- **custom_data:** UTM і ID оголошення, кнопка, сторінка, referrer + пристрій: модель, ОС і версія, браузер, екран, viewport, DPR, мова, часовий пояс, мережа, пам'ять, ядра, тач.
- **Продаж:** value, currency, order_id, contents, content_ids, num_items + телефон / пошта / ім'я.

## SendPulse: HTTP-запити (метод POST, заголовок `X-Secret: <WEBHOOK_SECRET>`, тіло JSON)

Параметр старту бота (`/start <sid>`) зберегти в змінну контакту `sid`.

`https://pilgrimagency.pro/f1/bot-start`
```json
{"sid":"{{sid}}","tg_id":"{{telegram_id}}","username":"{{username}}","first_name":"{{first_name}}","last_name":"{{last_name}}","language_code":"{{language_code}}"}
```

`https://pilgrimagency.pro/f1/video`
```json
{"tg_id":"{{telegram_id}}"}
```

`https://pilgrimagency.pro/f1/lead` (заявка: `form`, кнопка «Написати Антону»: `dm`)
```json
{"tg_id":"{{telegram_id}}","phone":"{{phone}}","email":"{{email}}","name":"{{name}}","lead_type":"form"}
```

`https://pilgrimagency.pro/f1/purchase` (orderId унікальний — повтор вебхука не створить дубль)
```json
{"orderId":"<номер замовлення>","value":12000,"currency":"UAH","phone":"<телефон>","email":"<пошта>","name":"<ім'я>","tg_id":"<telegram id, якщо є>","product":"Вихід з платформи 30 днів"}
```
Продаж знаходить сесію за `tg_id`, `sid`, телефоном або поштою (телефон у будь-якому форматі: `067…`, `+380…`).

> Назви змінних у фігурних дужках залежать від налаштувань SendPulse — звір із вашими змінними контакту.

## UTM у Meta Ads (URL-параметри оголошення)
```
utm_source=fb&utm_medium=paid&utm_campaign={{campaign.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&utm_content={{ad.name}}&placement={{placement}}&site_source={{site_source_name}}
```
