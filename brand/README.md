# Оформление бота

| Файл | Куда | Как |
| --- | --- | --- |
| `avatar.png` (640×640) | фото профиля бота | @BotFather → `/setuserpic` → выбрать @flora_uchet_bot → отправить файл как фото |
| `cover.png` (640×360) | картинка в описании (видна до «Запустить») | @BotFather → `/setdescriptionpic` → выбрать бота → отправить файл как фото |

Тексты описания ставит `connectBot()` (setMyDescription, setMyShortDescription).
Фирменный цветок — ранункулюс: `ranunculus.svg` (он же в кассе: `miniapp/img/ranunculus.svg`, шапка и пустые экраны). Исходники картинок — `avatar.html`, `cover.html` (поменять и пересохранить скриншотом Chrome 640×640 / 640×360).
