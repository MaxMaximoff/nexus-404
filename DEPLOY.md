# Деплой на Timeweb через Git

Адрес после установки: https://soundplayground.twc1.net/nexus-404/.
Хостинг: аккаунт `cj745763`, сервер `vh466`, существующий сайт
`~/soundplayground`. Проект размещается рядом с `mutagen-lab`.

На сервере Node.js не нужен: сборка `app/dist/` хранится в Git.
В Vite задан `base: "/nexus-404/"`. В сборку включается `.htaccess`
с `Permissions-Policy: serial=(self), microphone=(self)` для Web Serial
и записи звука. Для подключения к SP-404MKII нужен HTTPS и Chrome/Edge.

## Первая установка

В SSH-консоли Timeweb:

```sh
cd ~/soundplayground/repos
git clone https://github.com/MaxMaximoff/nexus-404.git nexus-404
```

Репозиторий приватный. Если Git запросит авторизацию, используйте свой
GitHub login и token с доступом к этому репозиторию, как при установке
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

Локально, из папки проекта:

```sh
cd app
npm run ship
git add -u
git commit -m "Deploy Nexus-404 to Timeweb"
git push origin main
```

`npm run ship` собирает приложение и добавляет `dist` в индекс Git.
`git add -u` добавляет изменения уже отслеживаемых исходников; новые
исходные файлы добавляйте отдельно. После коммита и push сервер получает
готовую сборку через Git, как `mutagen-lab`.

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
