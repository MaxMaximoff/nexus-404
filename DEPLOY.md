# Деплой на Timeweb через Git

Адрес после установки: https://soundplayground.twc1.net/nexus-404/.
Хостинг: аккаунт `cj745763`, сервер `vh466`, существующий сайт
`~/soundplayground`. Проект размещается рядом с `mutagen-lab`.

На сервере Node.js не нужен: сборка `app/dist/` хранится в Git.
В Vite задан `base: "/nexus-404/"`. В сборку включается `.htaccess`
с `Permissions-Policy: serial=(self), microphone=(self)` для Web Serial
и записи звука. Для подключения к SP-404MKII нужен HTTPS и Chrome/Edge.

## Лицензия и исходники (AGPL-3.0)

В сборке Essentia.js (AGPL-3.0), поэтому Nexus-404 целиком под AGPL-3.0
(`LICENSE`, `THIRD_PARTY.md`). Каждый, кто открывает сайт, должен иметь
доступ к исходникам именно той версии, что на сервере. Как это устроено:

- репозиторий `MaxMaximoff/nexus-404` на GitHub **публичный**;
- в шапке приложения ссылка «Source», внизу страницы — уведомление о
  лицензии, «Source code (коммит)» и «Third-party licenses»;
- сборка вшивает коммит исходников (`__SOURCE_COMMIT__`, `vite.config.ts`),
  ссылка ведёт на `github.com/MaxMaximoff/nexus-404/tree/<коммит>`;
- `npm run ship` отказывается собирать, если исходники не закоммичены
  (`app/scripts/check-source.mjs`; отличаться может только `app/dist`), —
  иначе ссылка вела бы на код, отличный от собранного;
- рядом со сборкой лежат `LICENSE.txt` и `THIRD-PARTY-LICENSES.txt`
  (тексты лицензий всех рабочих зависимостей из `package-lock.json`).

Не удаляйте с GitHub коммиты, на которые ссылаются выложенные сборки
(не переписывайте историю `main` force-push'ем).

## Первая установка

В SSH-консоли Timeweb:

```sh
cd ~/soundplayground/repos
git clone https://github.com/MaxMaximoff/nexus-404.git nexus-404
```

Репозиторий публичный, авторизация для клонирования не нужна. Если Git
всё же её запросит, используйте GitHub login и token, как при установке
`mutagen-lab`. Не записывайте token в документацию или команды с URL.

После успешного клонирования:

```sh
find ~/soundplayground/repos/nexus-404/app/dist -type d -exec chmod 755 {} \;
find ~/soundplayground/repos/nexus-404/app/dist -type f -exec chmod 644 {} \;
ln -s ~/soundplayground/repos/nexus-404/app/dist ~/soundplayground/public_html/nexus-404
```

Существующие настройки сайта и SSL уже используются `mutagen-lab`.
Если `public_html/nexus-404` уже существует, сначала проверьте его:
не удаляйте существующую папку или ссылку вслепую.

Проверка: откройте https://soundplayground.twc1.net/nexus-404/.
В браузере должны загрузиться интерфейс, JavaScript, CSS и шрифты.
Подключение к устройству проверяется отдельно в Chrome/Edge с SP-404MKII.

## Обновление

Локально, из папки проекта. Сначала исходники — отдельным коммитом, потом
сборка из них (на этот коммит и ведёт ссылка «Source»):

```sh
cd app
git add -A ..
git commit -m "feat: …"
npm run ship
git commit -m "Deploy Nexus-404 to Timeweb"
git push origin main
```

Перед `git add -A` проверьте `git status`: в коммит попадут и новые файлы.
`npm run ship` проверяет, что исходники закоммичены, собирает приложение и
добавляет `dist` в индекс Git. После push сервер получает готовую сборку
через Git, как `mutagen-lab`.

Проверка после деплоя: ссылка «Source» на сайте открывает на GitHub коммит
с исходниками, `/nexus-404/LICENSE.txt` и `/nexus-404/THIRD-PARTY-LICENSES.txt`
открываются.

На сервере:

```sh
cd ~/soundplayground/repos/nexus-404/app
git pull --ff-only
```

Ссылка из `public_html` остаётся прежней и сразу использует обновлённый `app/dist`.
Git работает и из подпапки `app`: он обновляет весь репозиторий `nexus-404`.

Если после обновления появился 403, восстановите права из этой же папки:

```sh
find dist -type d -exec chmod 755 {} \;
find dist -type f -exec chmod 644 {} \;
```
