# bb для Windows и macOS

bb - приложение для работы с GPT и Claude через вашу рабочую зону на сервере.

Скачать последнюю версию:

- [Windows x64 - bb-setup.exe](https://github.com/meloch287/bb-desktop/releases/latest/download/bb-setup.exe)
- [Mac с Apple Silicon - bb-mac-arm64.zip](https://github.com/meloch287/bb-desktop/releases/latest/download/bb-mac-arm64.zip)
- [Mac с Intel - bb-mac-x64.zip](https://github.com/meloch287/bb-desktop/releases/latest/download/bb-mac-x64.zip)

На Windows запустите установщик. На Mac распакуйте ZIP и перенесите `bb.app` в папку «Программы».

Отправьте боту команду `/desktop`, скопируйте личную ссылку подключения и вставьте её в приложение. Не передавайте эту ссылку другим людям.

Для обновления полностью завершите bb и установите новую версию поверх существующей. На Mac замените прежний `bb.app` в «Программах». Сохранённое подключение остаётся в данных приложения.

Текущий Windows-установщик не подписан. Если SmartScreen блокирует запуск, нажмите «Подробнее», затем «Выполнить в любом случае».

Mac-сборки имеют локальную ad-hoc-подпись и не нотариализованы Apple. Если macOS блокирует первый запуск, после попытки открыть bb перейдите в «Системные настройки» - «Конфиденциальность и безопасность», нажмите «Всё равно открыть» для bb и подтвердите открытие.

Для разработки используется Node.js 22 или новее. Проверка исходников:

```sh
npm ci
npm test
npm run check
```

Сборка нужной платформы:

```sh
npm run build:win
npm run build:mac:arm64
npm run build:mac:x64
```

Mac-архивы собираются на macOS. Ресурсы официальных сборок загружаются автоматически и проверяются по SHA256. Готовые файлы находятся в `dist/`.
