# SP-404MKII в браузере: технико-исследовательский отчёт

Дата: 2026-10-06. Основной источник: [TuscanPL/SparkyMK2](https://github.com/TuscanPL/SparkyMK2), коммит `3007b5d` (v0.7.3, 2026-10-04). Ниже `SM/…` — короткая запись ссылки `https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/…`.

Как помечены утверждения:

- **[Ф] Факт.** Источник прямо утверждает это, обычно с пометкой «confirmed/verified on firmware 5.52», либо это документация Roland или Chrome/MDN. Сам я на железе ничего не проверял.
- **[К] Вывод из кода.** Так реализовано в исходниках SparkyMK2, но в спецификации не отмечено как проверенное.
- **[П] Предположение.** Мой вывод, его нужно проверить.
- **[Э] Проверено нами на реальном SP-404MKII** (Windows 11, Chrome). Подробности в §0.

---

## 0. Проверено на нашем SP-404MKII (2026-10-06, Windows 11 26300, Chrome)

**Чтение в браузере работает [Э].** Web Serial открыл порт `0582:02E7`. На все read-only запросы устройство ответило по спецификации SparkyMK2, ни одного таймаута или сбоя разбора. Драйверы не ставились.

| Проверка | Результат [Э] |
|---|---|
| Топология (PnP) | Хаб `0424:2422` → `0582:0281` (`usbccgp`; `MI_00` = `usbaudio`, `wdma_usb.inf`; serial `SP-404MKII-G-423721E0R7158`) и `0582:02E7` (`usbser`, `usbser.inf`, **COM3**, «Bus reported device description» = `Roland SP-404MKII`) |
| USB serial number у `02E7` | **Отсутствует**: Windows сгенерировала instance ID `9&14A76F66&0&1`. Это может влиять на то, сохранит ли Chrome разрешение (см. §8) |
| Нативный доступ (.NET SerialPort, `tools/sp404-probe.ps1`) | Работает: 921600 8N1, DTR+RTS, пауза 350 мс |
| Web Serial в Chrome: `FE 66 00` status | `7E 00 00 00 00 0c 00 00 ff ff ff ff 00 02 01 00 00 0b 33`. Байт 5 менялся, когда на устройстве нажимали pad'ы (0 → 12 = A13) |
| `FD 00 00` настройки проекта + 16 имён | 147 B + 16 × `35 nn name`. Имена приходят с шагом примерно 22 мс, весь пакет около 350 мс |
| `9E` pad block × 32 (банки A и B) | 327 B. Round-trip **1–3 мс** на pad, значит все 160 pad'ов читаются меньше чем за 0,5 с |
| Разбор полей pad block | Совпадает с `03-parameters.md`. A1: size 77 312, start 512, level 43, BPM 90,00. A15: BPM 200,00. B1: BPM 137,00, BPM Sync = 1 |
| Файловое API: stat, open RO, read 512, close | Заголовки `RFWV` 48000 / 2 ch / 16 bit; `pcmBytes` = size − 512. Отсутствующий файл: stat → −1, errno 2 |
| opendir, readdir, closedir на `PROJECT_01/SMPL` | 33 файла, порядок не отсортирован. Набор BANK1-* совпадает с 12 непустыми pad'ами банка A. closedir после конца листинга → 0 (внутренняя память) |
| `18` free space | 14 861 600 KB (около 14,2 GB). Перед ответом пришло незапрошенное короткое `F0 41 7A 7C 00 F7`, как описано в спецификации |
| `3A 00 00 00` MKII EXIT | Ответа нет, как описано в спецификации. Повторное подключение после этого работает |
| Read-only guard в PoC | Ни одна команда записи не ушла |
| Reconnect после перезагрузки страницы | `getPorts()` вернул порт, подключение без окна выбора |
| Reconnect после того, как выдернули и вставили кабель | `read error: The device has been lost` → событие `disconnect`. После того как кабель вставили, пришло событие `connect`, Reconnect сработал **без окна выбора** |
| Reconnect после полного перезапуска Chrome | `getPorts()` на старте вернул 1 порт, подключение **без окна выбора**. Разрешение сохраняется, **хотя у порта нет USB serial number** |

**Запись из браузера работает [Э]** (`sp404-write-poc.html` + `lib/sp404.js`, проект-песочница 4 с заводским контентом):

| Проверка | Результат [Э] |
|---|---|
| Импорт `click_120bpm_4s.wav` на пустой C2 из Chrome | Последовательность `FB A0` → `91 pad 01 00` (→ `11 00`, плюс лишний `11 00 00 00 00`) → `9D` (→ `1D 00`) → unlink TMP/SMP (−1, файлов нет) → open 0x602 → seek 512 → write → seek 0 → заголовок → close → stat → `1E` блок (→ `1E 00`) → `9F` (→ полный блок `1E` и `1F 21 00 00`) → `FC`. Ошибок нет |
| Заголовок SMP, собранный нами | Первые 0x30 байт **побайтно равны** заголовку заводского сэмпла с теми же параметрами. После записи перечитан с устройства: MD5 сходится |
| BPM после импорта (`01 6F`) | Эхо пришло, в блоке f9 = 12000 |
| Сравнение блока C2 (наш импорт) с C1 (импорт через App) | Совпадают все поля, имя, chop points и хвост. Отличается только f27 (копия BPM при загрузке проекта, у C1 уже была перезагрузка) |
| Звук | C2 на устройстве звучит так же, как C1 |
| Скорость | 768 000 B PCM примерно за 1,08 с, то есть **около 0,7 MB/s** (SparkyMK2 заявляет около 2 MB/s) |
| Пакетный импорт 3 файлов (drag & drop на C3 → C3, C4, C5) | Все три прошли, commit = 0, MD5 заголовков сходится на устройстве: 44,1k mono → `decodeAudioData` → SMP **1 канал**, 480 512 B; 96k/24 stereo → 48k/16, 659 072 B; 48k/16 stereo 30 s → bit-exact, 5 760 512 B. Длинные имена обрезаются до 23 символов |
| Скорость после склейки пачки в один `writer.write` | 30-секундный файл (5,76 MB) примерно за 6,9 с, то есть **около 0,8 MB/s**. Склейка почти не помогла, значит, узкое место — подтверждение каждой пачки (около 0,37 с на 307 KB) или скорость записи на самом устройстве. Сравнить со временем импорта того же файла через App |
| Выключение и включение питания после нашего импорта | C2–C5 на месте, BPM 120 у C2 сохранён. f27 у C2 стало 12000, как и предсказывалось. Блок C2 совпадает с C1 (импорт App). Gate, переключённый кнопками на SP, вернулся в исходное значение (правка на устройстве не сохранилась) |
| Звук | C2–C5 играют. Mono (C3) звучит в обоих каналах, ресемплированные файлы звучат корректно |
| Параметры pad'а из `app/` (C1, проект 4) | Loop `6B` = 1: pad играет по кругу. One Shot (`70` = flags \| 32, затем Gate = 0, Loop = 0, `72` = 0): Gate и Loop в блоке выключены, pad доигрывает после отпускания. Start/End `67`/`68` = 48 000 / 96 000 кадров (stereo): в блоке 192 512 / 384 512 байт, играют ровно два щелчка из четырёх. Level `69` = 37: заметно тише. BPM Sync `6E` = 1: сэмпл 120 BPM играет медленнее (темп банка/проекта ниже) |
| Выключение и включение питания после правок параметров | Level 37, Gate 0, Loop 0, One Shot 1, Start/End 1–2 s **сохранились**. Удалённые правки параметров, как импорт и BPM, сохраняются сразу |

**Новые наблюдения, которых нет в спецификации SparkyMK2:**

- **Флаги (`70`, поле 10), бит 2 (`4`):** в спецификации описаны только биты 0, 3, 4, 5. Что выяснили на нашем SP:
  - бит стоит только у длинных лупов с «настоящим» темпом (B1 137,00; C1–C4 138,00). У 28 one-shot'ов в банках A и F его нет;
  - выключение BPM Sync у B1 на устройстве изменило **только** f8. Бит 2 остался, значит, это не BPM Sync;
  - ручная смена BPM у A1 (90 → 120) на устройстве бит 2 не установила.
  - ~~Гипотеза: «у сэмпла определён исходный темп»~~ — **опровергнута [Э]**: у заводских лупов в проекте 4 (BPM 123,00 и 93,20, f27 = BPM) флаги = 0. Смысл бита 2 по-прежнему неизвестен.
- **Импорт официальным App, эталон [Э].** Файл `test-audio/click_120bpm_4s.wav` (48k/16/stereo, 768 000 B PCM) импортирован App на пустой C1 проекта 4, настройки по умолчанию. В блоке pad'а изменились **только**: имя = имя файла без расширения, f0 size = 768 512, f1 start = 512, f2 end = 768 512, f11 loop top = 512. BPM и f27 остались 90,00, флаги 0, Gate = 1 (значение пустого pad'а). Это совпадает с `PadBlock::assign_sample` в SparkyMK2: блок читается, меняются эти 5 полей, блок записывается обратно. Дампы: `captures/P4-C1-empty.txt`, `captures/P4-C1-app-import.txt`.
- **Смена BPM в официальном App [Э]:** BPM у C1 изменён в App на 120.00. В блоке изменилось **только** f9 = 12000; f27, флаги и остальные поля прежние. Так же ведёт себя ручная смена BPM на устройстве. Для MVP: поле BPM = одна команда set-parameter `6F`, f27 не трогаем.
- **После смены проекта блоки pad'ов какое-то время читаются пустыми [Э]:** первый проход по 160 pad'ам сразу после переключения на проект 4 вернул size = 0 везде, повторный через полминуты — нормальные данные. Клиенту нужно дождаться загрузки проекта (уведомление `1A`, см. спецификацию), прежде чем читать pad'ы.
- **Поле f27 — копия BPM, снятая при загрузке проекта [Э].** Спецификация SparkyMK2 говорит «всегда 9000», но у нас f27 совпадает с BPM у всех pad'ов (13700, 20000, 12300…). Ручная смена BPM (на устройстве у A1, в App у C1) меняет только f9, f27 остаётся прежним. **После выключения и включения питания f27 у C1 стало 12000 = новому BPM.** Значит, f27 не хранится (в `PADCONF.BIN` оно 0, так и в SparkyMK2) и пересчитывается при загрузке проекта. Для MVP f27 не нужен.
- **Поле Gate у пустых pad'ов:** в блоке стоит `1`, у загруженных `0`. Level пустого pad'а = 127, BPM = f27 = 9000.
- **Слова 7–11 настроек проекта:** значения 1, 12, 2, 3, 13, а не 32, как сказано в спецификации. Смысл неизвестен; возможно, это выбор эффектов.
- **Байты 13–18 status:** `02 01 00 00 0b 33`, не меняются. Это кандидат на версию прошивки или модели: сравнить с UTILITY → версия на экране SP.

---

## 1. Вердикт

**A. Да, версия только для браузера практически реализуема, но через Web Serial API, а не через WebUSB.**

> **Подтверждено на железе (2026-10-06) [Э]:** из Chrome на Windows 11 без установки чего-либо прочитаны проекты и pad'ы, WAV импортирован на pad, BPM задан. Результат неотличим от импорта официальным App. Переподключение работает без повторного выбора порта. Подробности в §0.

Почему:

1. **[Ф]** Официальный SP-404MKII App общается с устройством не по MIDI, не через Mass Storage и не через vendor-specific bulk-протокол. Он использует **обычный последовательный порт USB CDC-ACM**: отдельное USB-устройство `0582:02E7`, которое в Windows видно как COM-порт (драйвер `usbser`), в Linux как `/dev/ttyACM*` (`cdc_acm`), в macOS как `/dev/cu.usbmodem*`. Источники: [SM/docs/re/00-findings.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/00-findings.md), [SM/README.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/README.md).
2. **[Ф]** Web Serial в Chrome и Edge на десктопе (89+) умеет работать именно с такими портами: CDC-ACM, фильтр по `usbVendorId`/`usbProductId`, управление DTR/RTS. Источники: [Chrome: Web Serial](https://developer.chrome.com/docs/capabilities/serial), [MDN Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API).
3. **[Ф]** Протокол поверх порта уже полностью разобран и реализован: framing, файловое API (open/read/write/seek/stat/readdir…), чтение и запись блоков pad'ов, set-parameter (BPM и прочее), последовательность импорта сэмпла. Источник: [SM/docs/re/01-transport.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/01-transport.md), [02-files.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/02-files.md), [03-parameters.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/03-parameters.md).
4. **[Ф]** Хост делает всю обработку аудио сам: декодирует, ресемплирует в 48 kHz/16 bit, собирает файл `.SMP`. Устройство получает только готовый файл. Всё это легко делается в браузере: `decodeAudioData`/свой WAV-парсер плюс MD5 на JS.
5. **[Ф]/[П]** WebUSB для этого интерфейса **не подходит**. Интерфейс CDC занят системным драйвером, а Chrome не может захватить интерфейс, у которого уже есть драйвер. На Windows для WebUSB нужен WinUSB ([Chrome: Build for WebUSB](https://developer.chrome.com/docs/capabilities/build-for-webusb)). Подменять `usbser` на WinUSB через Zadig нельзя: это сломает официальный App и SparkyMK2. Значит, путь только через Web Serial.

Оговорки, которые не меняют вердикт:

- Firefox и Safari не подходят: Web Serial там не поддерживается или поддерживается ограниченно ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)). Целевая платформа — Chrome/Edge desktop.
- На Linux пользователю может понадобиться доступ к `/dev/ttyACM*`: группа `dialout`/`uucp` или udev-правило ([SM/packaging/linux/70-sp404mkii.rules](https://github.com/TuscanPL/SparkyMK2/tree/3007b5d/packaging)). Браузер это исправить не может. На Windows и macOS установка не нужна **[Ф]**.
- Протокол проверен в SparkyMK2 на прошивке 5.52 **[Ф]**. На других версиях прошивки он не проверялся.

---

## 2. Как устроен USB у SP-404MKII

### 2.1 Обнаружение и топология [Ф]

Источник: [00-findings.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/00-findings.md).

Внутри SP-404MKII стоит USB 2.0-хаб `0424:2422`, к нему подключены **два отдельных USB-устройства**:

| VID:PID | Класс | Имя | Драйвер Windows | Linux |
|---|---|---|---|---|
| `0582:0281` | Composite: USB Audio 2.0 + USB MIDI | `SP-404MKII` | usbaudio (встроенный) | snd-usb-audio |
| `0582:02E7` | **CDC-ACM** (02/02/00) | `Roland SP-404MKII` | **usbser → COM-порт** | **cdc_acm → /dev/ttyACM\*** |

- **Endpoint'ы CDC-устройства [Ф]:** bulk OUT `0x03`, bulk IN `0x82`, interrupt IN `0x81` ([01-transport.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/01-transport.md)).
- **Как официальный App находит устройство [Ф, по строкам бинарника]:** перебирает последовательные порты и сравнивает «Bus reported device description». Для работы с портом используется модуль serial port из JUCE.
- **Как находит SparkyMK2 [К]:** перебирает порты с VID/PID `0582:02E7`; на macOS отбрасывает `tty.*` и оставляет `cu.*`. Код: [SM/crates/sp404-device/src/lib.rs:77 `find_ports`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/lib.rs#L77).
- **Драйвер [Ф]:** Roland пишет, что драйвер не нужен, потому что аудио работает по USB Audio Class 2.0 ([Roland Reference Manual](https://static.roland.com/manuals/sp-404mk2_reference/eng/17805250.html), [Sweetwater](https://www.sweetwater.com/sweetcare/articles/how-to-use-the-sp-404mkii-software/)). CDC-порт на Windows обслуживает встроенный `usbser` ([SM README](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/README.md)).
- **Аудио и передача файлов одновременно [Ф]:** Roland отдельно говорит, что сделала USB-систему, в которой аудио, MIDI и передача файлов работают одновременно ([Roland Engineering article](https://articles.roland.com/roland-engineering-designing-the-sp-404mkii/)). Это согласуется с тем, что это два разных USB-устройства.

### 2.2 Какой протокол использует Roland App [Ф]

- Это не стандартный MIDI SysEx по MIDI-порту, не Mass Storage и не vendor-specific bulk. Это **собственный протокол поверх CDC-ACM serial**. Payload'ы файлового канала оформлены как SysEx (`F0 41 7A … F7`, где `41` — ID Roland), но идут **через COM-порт**, а не через MIDI.
- Внутренние имена в бинарнике App: `BmcIpcIn`, `BmcIpcOut`; префикс файлового пространства `/SP404REMOTE//`.
- App требует прошивку **4.xx или новее**.

### 2.3 Параметры порта и handshake [Ф/К]

Источник: [01-transport.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/01-transport.md), [lib.rs:152 `Device::open`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/lib.rs#L152).

1. Открыть порт: 921600 baud, 8N1, без flow control. Для CDC скорость, скорее всего, ни на что не влияет **[П]**.
2. Выставить **DTR и RTS** (control line state `0x0003`). В комментарии к коду сказано, что без этого control-канал не отвечает **[К]**. Но в спецификации отмечено, что настоящей причиной «молчания» оказался нулевой length byte, так что необходимость DTR/RTS не доказана **[Ф]**.
3. Подождать примерно **350 мс**. Нужно ли это на самом деле, не проверено **[Ф]**.
4. Отдельного handshake нет. Первая команда — status poll `FE 66 00`. App шлёт его каждые 500 мс.
5. На Connect App ещё отправляет `9A <proj> 00` (выбор проекта), на Disconnect — `9D` и `3A 00 00 00` (MKII EXIT: устройство уходит с remote-экрана).

### 2.4 Framing [Ф]

Источник: [frame.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/frame.rs).

Каждое направление — это **поток байт**. Сообщения могут разрезаться на несколько USB-transfer'ов или склеиваться в один.

```
short (12 B): 12 | src | dst | ch | payload[7] | len        (len — в байте 11, 0 игнорируется)
long  (16 B + N): 13 | src | dst | ch | 8 B junk | len:u32 LE | payload[N]
src/dst: host 0x60, device 0xE0.   ch: 0x05 control/параметры, 0x06 файловое API
```

На транспортном уровне **нет CRC, нет sequence numbers и нет ACK**. Подтверждения есть на прикладном уровне: каждый запрос получает ответ, у записи есть batch-ACK (см. ниже).

### 2.5 Канал 0x06: файловое API, похожее на POSIX [Ф]

Источник: [fileapi.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/fileapi.rs), [septet.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/septet.rs).

```
request: F0 41 7A 03 op handle/flags(5 septets) arg(5 septets) tail… F7
status : F0 41 7A 7A result(5) extra(5) F7          (result −1 = ошибка, extra = errno)
data   : F0 41 7A 02 handle(5) len(5, флаг 0x40 = last) data[len] F7
```

Целые числа кодируются как 35 бит, по 7 бит на байт, big-endian: −1 = `7F 7F 7F 7F 7F`. Данные файла передаются сырыми 8-битными байтами.

| op | Операция | | op | Операция |
|---|---|---|---|---|
| 00 | open (flags 0 = RO, 0x602 = RDWR\|CREAT\|TRUNC) | | 0C/0D/0E | opendir / closedir / readdir |
| 03 | close | | 12 / 13 | stat / fstat (mode u32 LE, size u32 LE) |
| 04 | read (чанки ≤ 0x5000, последний с флагом `last`) | | 17 | rename |
| 06 | write (≤ 20480 B на чанк) | | 18 | свободное место в KB |
| 07 | seek | | 09 / 0A / 0B | mkdir / unlink / rmdir |

**Тома [Ф]:**

- `/SP404REMOTE//…` — внутренняя память устройства. Там лежат проекты и сэмплы: `ROLAND/SP-404MKII/PROJECT_NN/{PADCONF.BIN, SMPL/BANKb-pp.SMP, PTN/…}`.
- `/…` — SD-карта: `IMPORT/`, `EXPORT/`, `BKUP/`, образы прошивки.

**Запись [Ф]:**

- App отправляет до **15 чанков по 20480 B** без ожидания ответа. У последнего чанка в batch'е стоит флаг `0x40`.
- Устройство отвечает одним status, в `result` — **сколько байт записано за batch**. Это и есть ACK и проверка.
- `close` после записи может занять до 20 с ([коммит 9de8237](https://github.com/TuscanPL/SparkyMK2/commit/9de8237)).
- Пропускная способность около **2 MB/s** ([README](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/README.md)).

### 2.6 Канал 0x05: управление и параметры [Ф]

Источник: [03-parameters.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/03-parameters.md), [proto/control.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/control.rs).

| Запрос | Ответ | Смысл | R/W |
|---|---|---|---|
| short `FE 66 00` | long `7E proj 00 bank 00 pad … pos:u32 … mode` | status (проект, выбранный bank/pad, позиция воспроизведения, working mode) | R |
| short `FD proj 00` | long `7D …` (147 B) + 16× long `35 nn name` | настройки проекта (tempo, bank tempo/volume/protect) и имена 16 проектов | R |
| short `9E pad:u16` | long `1E pad …` (327 B) | **блок pad'а**: размер, start/end, level, gate, loop, BPM, флаги, имя, chop points | R |
| long `9C 05 pad ch start n spp` | long `1C … (min,max)×n` | пики waveform, считает устройство | R |
| long `01 id 00 target:u16 value:i32` | эхо | **set parameter** (target = pad 0..159 или `FFFF` для глобальных) | **W** |
| `02 pad:u16 name…` | эхо | имя сэмпла | **W** |
| `9A proj 00` | `1A 00` | выбор текущего проекта | W (состояние) |
| `91 pad 00 00` / `98` / `A3` / `95` / `92` | … | delete / truncate / normalize / move / **Init (стирает проект!)** | **W** |

Индекс pad'а: `bank × 16 + pad`, где A1 = 0, J16 = 159. Ошибки приходят асинхронно short-сообщением `32 code:i32` (например, −119 Invalid Format, −92 BANK Protected).

**Параметры pad'а** (id для `01`, соответствующее поле блока = id − 0x66):

| id | Параметр | Кодирование |
|---|---|---|
| `67`/`68` | Start/End | в кадрах (в самом блоке хранится байтовый offset в SMP) |
| `69` | Level | 0–127 |
| `6A` | Gate | 0/1 |
| `6B` | Loop | 0/1 |
| `6E` | BPM Sync | 0/1 |
| **`6F`** | **BPM** | **BPM × 100, 4000–20000** |
| `70` | флаги | бит 5 = One Shot; App при этом шлёт ещё Gate=0, Loop=0, `72`=0 |
| `75` | Play mode | Fwd/Rev/Ping-Pong |
| `76` | Time stretch | — |
| `78` | Balance | — |
| `7D`–`7F` | AHR | — |
| `8E`–`9D` | chop points | — |

Глобальные параметры: `0A` project tempo, `21+bank` bank tempo, `17+bank` bank protect и т.д.

### 2.7 Формат сэмпла `.SMP` [Ф]

Источник: [02-files.md](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/docs/re/02-files.md), [formats/smp.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-formats/src/smp.rs#L111).

- **Заголовок, 512 B:** `"RFWV"`, size−8, 48000, каналы (1 или 2), 16 бит (все поля u32 **BE**). На смещении 0x20 лежит **MD5 от байтов 0x04–0x13**: это единственная контрольная сумма, вероятно, её проверяет «Hash Check Error». Байты 0x30–0x1FF — произвольный filler.
- **PCM:** 16-bit signed **big-endian**, interleaved.
- **Формат на входе:** 48 kHz, 16 bit, mono или stereo. Всё остальное конвертирует хост. App принимает WAV/BWF, AIFF, FLAC, MP3 и (по словам Roland) M4A ([Roland: Importing a Sample](https://static.roland.com/manuals/sp-404mk2_app/eng/78775991.html)).
- **Лимиты:** минимальная и максимальная длина сэмпла неизвестны (ошибки «Too Short/Too Long Sample»). Место во внутренней памяти — около 14 GB свободно на тестовом устройстве.

---

## 3. Ответы на конкретные вопросы

| Вопрос | Ответ |
|---|---|
| Как ПК обнаруживает SP | Два USB-устройства за внутренним хабом. Для управления используется CDC-ACM `0582:02E7` **[Ф]** |
| Interfaces/endpoints | CDC: bulk OUT 0x03, bulk IN 0x82, interrupt IN 0x81 **[Ф]**. Номера interface'ов не задокументированы; PoC покажет их кнопкой WebUSB-диагностики |
| MIDI/SysEx, bulk, MSC или своё? | Свой протокол поверх CDC-ACM serial; payload'ы похожи на SysEx **[Ф]** |
| Нужен драйвер Roland? | Нет. Windows: `usbser`, macOS/Linux: встроенный CDC **[Ф]** |
| Доступ через WebUSB? | **Нет** на практике: интерфейс занят `usbser`/`cdc_acm`/драйвером macOS **[Ф: правила Chrome]**, **[П: конкретно для SP проверить кнопкой диагностики]**. Правильный API — **Web Serial** |
| Захват драйвером ОС мешает Chromium? | Для WebUSB да. Для Web Serial нет: Web Serial работает именно поверх системного serial-драйвера **[Ф]** |
| VID/PID | `0x0582` (Roland); `0x02E7` serial, `0x0281` audio/MIDI **[Ф]** |
| Известные команды | Полный список выше: ~15 файловых op и ~30 control-команд **[Ф]** |
| Handshake | Отдельного нет: DTR+RTS, 350 мс, затем запросы **[Ф/К]** |
| Список banks/pads | 160 × `9E pad` → блок 327 B **[Ф]**. Число каналов есть только в заголовке SMP (open/read 512/close) **[Ф]** |
| Загрузка WAV | Хост конвертирует в SMP и пишет его файловым API, затем шлёт pad block и commit (§4) **[Ф/К]** |
| Выбор bank/pad | Через путь `PROJECT_NN/SMPL/BANKb-pp.SMP` и индекс pad'а в командах `91/1E/9F`. Проект должен быть **текущим** **[Ф]** |
| Metadata | Имя — внутри pad block при импорте или командой `02`. BPM, gate, loop, one-shot, level, start/end — через `01 id` **[Ф]** |
| Менять BPM после загрузки | Да: `01 6F 00 pad:u16 BPM×100:i32` **[Ф]** |
| Читать сэмплы и metadata обратно | Да: pad block `9E`, файл `.SMP` через read, пики `9C` **[Ф]** |
| Ограничения WAV | На устройство идёт только 48k/16/mono|stereo; конвертация на хосте **[Ф]**. Мин./макс. длина неизвестны |
| CRC/chunking/ACK/seq | MD5 в заголовке SMP; чанки 20 KB, batch по 15, ACK = число байт; sequence numbers нет **[Ф]** |
| Безопасность экспериментов | Read-only команды безопасны. Опасны: `92` Init (стирает текущий проект; был реальный инцидент), `91` delete, `35` rename (всегда переименовывает текущий проект), любые файловые write/unlink/rename **[Ф]**. Не трогать `QSPI.bin`, `FCTRY/`, `SP404MKII_APP*.bin` **[П]** |

---

## 4. Где это в коде SparkyMK2

| Задача | Файл / функция |
|---|---|
| Поиск и открытие порта, DTR/RTS, пауза 350 мс | [sp404-device/src/lib.rs:77 `find_ports`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/lib.rs#L77), [:152 `Device::open`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/lib.rs#L152) |
| Отправка и приём, request/reply, сериализация операций | [lib.rs:236 `transact`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/lib.rs#L236), [:331 `read_loop`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/lib.rs#L331), [:187 `exclusive`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/lib.rs#L187) |
| Framing | [sp404-proto/src/frame.rs:102 `Message::encode`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/frame.rs#L102), [:148 `Decoder::next_message`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/frame.rs#L148) |
| Septet-целые | [sp404-proto/src/septet.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/septet.rs) |
| Файловое API (кодеки) | [sp404-proto/src/fileapi.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/fileapi.rs) |
| Файловые операции, запись batch'ами, чтение | [sp404-device/src/files.rs:140 `write_with`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/files.rs#L140), [:112 `read`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/files.rs#L112), [:257 `list_dir`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/files.rs#L257) |
| Status и чтение banks/pads | [sp404-device/src/control.rs:82 `status`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/control.rs#L82), [:244 `pad_block`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/control.rs#L244); разбор блока: [sp404-proto/src/pad.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/pad.rs) |
| **Импорт WAV и назначение на pad** | [sp404-device/src/control.rs:533 `import_smp`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/control.rs#L533); сообщения: [proto/control.rs:393 `mod import`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/control.rs#L393); блок: [pad.rs:191 `assign_sample`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/pad.rs#L191), [:210 `write_payload`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/pad.rs#L210) |
| Декодирование и ресемплинг аудио, сборка SMP | [sp404-formats/src/audio.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-formats/src/audio.rs), [smp.rs:111 `header`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-formats/src/smp.rs#L111) |
| Изменение параметров (BPM и др.) | [proto/control.rs:121 `set_param`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/control.rs#L121), [device/control.rs:270 `set_param`](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-device/src/control.rs#L270), таблица id: [proto/params.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-proto/src/params.rs) |
| BPM detect (по желанию) | [sp404-dsp/src/tempo.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/crates/sp404-dsp/src/tempo.rs) |
| Команды Tauri и последовательность Connect | [app/src-tauri/src/commands.rs](https://github.com/TuscanPL/SparkyMK2/blob/3007b5d/app/src-tauri/src/commands.rs) |

**Последовательность импорта** (`import_smp`; для pad P в текущем проекте N):

```
0. status → убедиться, что N — текущий проект; 9E P → взять текущий pad block
1. FB A0 00                       (begin, без ответа)
2. 91 P 01 00  → 11 00            (release slot)
3. 9D          → 1D 00            (stop)
4. unlink BANKb-pp.TMP, unlink BANKb-pp.SMP
5. open BANKb-pp.SMP flags 0x602 → handle
6. seek 512; write PCM batch'ами (15×20 KB, флаг 0x40 на последнем, ACK = байты)
7. seek 0; write 512-байтный заголовок RFWV (с MD5)
8. close (таймаут до 20 с); stat → размер совпадает
9. long 1E P + первые 199 B блока: поле0=size, поле1=512, поле2=size, поле11=512, имя
10. 9F P → 1F P status(0)
11. FC 00 00                      (end)
12. (по желанию) 01 6F 00 P BPM×100 → эхо
```

Сопутствующие проекты: [jorgb/ugc-tools](https://github.com/jorgb/ugc-tools) (парсер PADCONF.BIN), [irpina/Sampson-Sample-Manager](https://github.com/irpina/Sampson-Sample-Manager). Оба работают с файлами на SD или в бэкапе, USB-протокол не используют. Альтернативной прошивки для SP-404MKII я не нашёл **[П: по результатам поиска]**. Прошивка обновляется образами `SP404MKII_APP0/1.bin` с SD-карты.

---

## 5. Браузерная сторона

| Тема | Вывод |
|---|---|
| **WebUSB** | Не подходит для `0582:02E7`: интерфейс занят системным CDC-драйвером; на Windows WebUSB нужен WinUSB **[Ф: [Chrome](https://developer.chrome.com/docs/capabilities/build-for-webusb)]**. `0582:0281` — Audio/MIDI, это защищённые классы **[Ф]** |
| **Web Serial** | Правильный API. Chrome/Edge 89+ на Windows, macOS, Linux, ChromeOS **[Ф]**. `requestPort({filters:[{usbVendorId:0x0582, usbProductId:0x02E7}]})`, `setSignals({dataTerminalReady:true, requestToSend:true})` **[Ф]** |
| `bufferSize` | По умолчанию **255 байт** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SerialPort/open)). Нужно ставить больше, например 1 MB: ответы на чтение приходят чанками по 20 KB **[Ф/П]** |
| HTTPS | Нужен secure context: HTTPS или `http://localhost` **[Ф]**. В iframe нужен `Permissions-Policy: serial` **[Ф]** |
| Разрешения | Пользовательский жест и выбор порта в системном диалоге при первом подключении **[Ф]** |
| Reconnect без диалога | `navigator.serial.getPorts()` возвращает ранее разрешённые порты, плюс события `connect`/`disconnect` **[Ф]**. Сохраняется ли разрешение после перезапуска браузера и переподключения кабеля, нужно проверить: это может зависеть от наличия USB serial number **[П]** |
| Большие файлы | Ограничений не видно: поток пишется чанками по 20 KB с batch-ACK. При ~2 MB/s файл 50 MB идёт около 25 с **[Ф: скорость в SparkyMK2]**. Web Serial доступен в Dedicated Worker, протокол можно вынести туда **[Ф]** |
| Драйверы Windows | Ничего ставить не нужно, `usbser` встроен **[Ф]**. Порт эксклюзивный: официальный App и SparkyMK2 должны быть закрыты **[К]** |
| Linux | Права на `/dev/ttyACM*` (группа dialout/uucp или udev `uaccess`) **[Ф]**. ModemManager может опрашивать новые ttyACM AT-командами **[П]**: проверить, при необходимости добавить udev-правило `ID_MM_DEVICE_IGNORE` |
| macOS | Использовать `cu.*`. Chrome сам выбирает нужный порт **[П]** |
| Несколько интерфейсов одновременно | Это разные USB-устройства. Web Serial (02E7) и Web MIDI/`getUserMedia` (0281) работают параллельно **[Ф/П]** |
| Web MIDI | Не нужен для файлов: файловый и control-протокол через MIDI-порт **не обнаружены** **[П]**. Можно использовать для превью нот. Для SysEx нужен отдельный prompt разрешения |
| WebHID | HID-интерфейса нет в топологии **[Ф]** |
| Декодирование аудио в браузере | `AudioContext({sampleRate:48000}).decodeAudioData()` (WAV, MP3, FLAC, OGG/AAC в Chrome); AIFF — свой парсер **[П]**. Если исходник уже 48k/16 bit, PCM лучше брать напрямую из WAV, чтобы получить bit-exact результат. MD5 — маленькая JS-библиотека (Web Crypto MD5 не умеет) |

---

## 6. Минимальная архитектура MVP (TypeScript, без установки)

```
src/
  transport/
    SP404Transport.ts      interface { open(); close(); write(u8); onBytes; onClose }
    WebSerialTransport.ts  navigator.serial, DTR/RTS, bufferSize, read loop, reconnect через getPorts()
  protocol/
    Frame.ts               short/long encode + потоковый FrameDecoder
    Septets.ts             35-битные целые
    ControlCodec.ts        status, projectSettings, padBlock, setParam, import begin/release/commit/end, errors(0x32)
    FileApiCodec.ts        open/read/write/seek/close/stat/opendir/readdir/unlink, parseReply
    PadBlock.ts            parse/assignSample/writePayload (327/199 B)
  SP404Device.ts           request/reply, очередь exclusive(), события (1A, 32, 7E), таймауты
  RemoteFs.ts              readFile, writeFile с batch'ами 15×20 KB и progress, listDir, stat
  PadRepository.ts         кэш 160 блоков текущего проекта, refresh по 1A, getBank(b)
  audio/
    decode.ts              File → PCM float/int16 (decodeAudioData / WAV fast path)
    Smp.ts                 int16 → BE + заголовок RFWV + MD5
  SampleUploader.ts        очередь batch import: decode → SMP → import_smp-последовательность → set BPM
  PadParams.ts             setBpm, setGate, setLoop, setOneShot (с побочными эффектами App), setName
ui/                        Connect, bank A–J, сетка 4×4, drag&drop, поле BPM (input type="text" inputmode="decimal"), progress
```

Ключевые правила реализации:

- одна операция за раз (`exclusive`), status poll на время импорта приостанавливается;
- импорт разрешён только в текущий проект;
- если bank protected, отказывать на стороне клиента, как это делает App;
- после любой операции перечитывать pad block.

Лицензия: SparkyMK2 распространяется под **GPL-3.0-or-later**. Порт их кода на TS сделает библиотеку GPL. Если нужна другая лицензия, реализуйте по спецификации (`docs/re`), не переводя код построчно. Это не юридическая консультация.

---

## 7. Proof of concept

Файлы в проекте:

- `sp404-poc.html` — только чтение, описан ниже.
- `sp404-write-poc.html` + `lib/sp404.js` — запись в песочнице: импорт на пустой pad (одиночный и пакетный, drag & drop), BPM, прогресс, проверка заголовка на устройстве. Guard `sandboxGuard` пропускает только команды импорта и `6F` для проекта-песочницы, пока тот текущий. Проверено на железе (§0).
- `tools/sp404-probe.ps1` — нативный read-only пробник (PowerShell + .NET SerialPort): `-Bank X`, `-All`, `-Pad C1 -Save файл` для побайтного сравнения блоков.
- `test-audio/` — тестовые WAV, `captures/` — дампы блоков из экспериментов.

Исходное описание read-only PoC:

Файл `sp404-poc.html`, один HTML без сборки.

1. `navigator.serial.requestPort` с фильтром `0582:02E7`. Пользователь просил `navigator.usb.requestDevice`, но по причинам из §5 это неверный API для данных. WebUSB-вызов оставлен отдельной **диагностической** кнопкой: она только печатает дескрипторы, а по флажку пробует `open()/claimInterface()`.
2. Открывает порт: 921600 8N1, bufferSize 1 MB, DTR+RTS, пауза 350 мс.
3. Read-only запросы:
   - status `FE 66 00`;
   - настройки и имена проектов `FD`;
   - 16 pad block'ов выбранного bank `9E`;
   - заголовки SMP: stat, open RO, read 512, close;
   - листинг `SMPL/`;
   - свободное место.
4. Встроенный **guard** блокирует любые payload'ы вне белого списка, а `open` разрешён только с flags = 0.
   - Единственная не-read команда — кнопка `MKII EXIT` (`3A 00 00 00`). Её шлёт официальный App при отключении, данные она не меняет.

Кодеры framing и septet'ов проверены в Node на тест-векторах SparkyMK2 (`frame.rs`, `septet.rs`, `fileapi.rs`). На реальном устройстве PoC **не запускался**.

---

## 8. Что неизвестно и требует проверки на железе

Состояние после проверки на железе 2026-10-06. Зачёркнутое — проверено.

1. ~~Открывается ли порт через Web Serial и отвечает ли устройство.~~ **[Э] Да** (Chrome, Windows 11).
2. Нужны ли DTR+RTS и пауза 350 мс; нужен ли keep-alive poll. **[Э] С ними работает**, без них не пробовали. Пауза около минуты без запросов соединение не рвала, keep-alive не понадобился. Более долгие паузы отдельно не проверяли.
3. Переводит ли открытие порта устройство в remote-режим; что будет без `MKII EXIT`. Явных эффектов на экране не замечено, повторные подключения без `MKII EXIT` работают. Отдельно не исследовали.
4. ~~Запись кусками по 20 KB через Web Serial на Windows.~~ **[Э] Работает**, ошибок таймаута нет, файл 5,76 MB прошёл.
5. Скорость: **[Э] около 0,8 MB/s** (30-секундный стерео-файл примерно за 7 с). **Тестовая конфигурация: SP подключён через два дешёвых USB-хаба**, это вероятная причина; прямое подключение не проверяли. Для MVP скорость признана достаточной. Склейка пачки в один `writer.write` не помогла. Открыто: так же ли медленно импортирует App и поможет ли отправлять следующую пачку, не дожидаясь подтверждения предыдущей (рискованно, только после сравнения с App).
6. ~~Переживает ли разрешение перезапуск браузера и переподключение кабеля.~~ **[Э] Да.** Не проверено: другой USB-порт компьютера, Edge.
7. Версия прошивки: команда для её чтения не задокументирована. Кандидат — байты 13–18 статуса (`02 01 00 00 0b 33`); сверить с версией на экране SP.
8. ~~Сохраняются ли импорт и BPM после выключения питания.~~ **[Э] Да**, и для App, и для нашего клиента (C2–C5 после выключения и включения питания на месте, BPM 120 у C2 сохранён). **Но:** Gate, переключённый **кнопками на самом SP** у C1/C2, после выключения питания вернулся в исходное значение. Похоже, устройство сохраняет свои правки не сразу (например, при смене проекта) **[П]**, а удалённые команды сохраняются сразу. Для MVP это не мешает.
9. Минимальная и максимальная длина сэмпла; поведение при Memory Full.
10. Поведение импорта, когда устройство в меню (working mode = 4: App блокирует редактирование). В MVP повторить блокировку App.
11. Неизвестные поля pad block'а (6, 25–42) и бит 2 флагов. При импорте копируются из прочитанного блока, как у App: проверено, блоки совпадают.
12. Linux и macOS: не проверялись (права на `ttyACM`, ModemManager).
13. Работает ли путь `SD:IMPORT/` как безопасный fallback. Для MVP не нужен: прямой импорт работает.
14. Ожидание загрузки проекта после смены проекта: сразу после переключения блоки pad'ов читаются пустыми. Нужно ждать уведомления `1A` или опрашивать.

---

## 9. Следующий шаг: MVP

Вопрос «можно ли без установки» закрыт: **можно**. Все функции MVP проверены на реальном устройстве из Chrome:

| Функция MVP | Проверено |
|---|---|
| Connect SP-404MKII, reconnect без выбора порта | ✔ |
| Просмотр 16 pad'ов банка | ✔ (160 pad'ов меньше чем за 0,5 с) |
| Drag & drop WAV на pad, выбор bank/pad | ✔ |
| Передача WAV в SP (48k/16 bit-exact; 44,1k, 96k/24, mono — через `decodeAudioData`) | ✔ |
| Поле BPM, смена BPM после загрузки | ✔ |
| Batch import нескольких файлов | ✔ |
| Progress bar и обработка ошибок | ✔ базово (прогресс по пачкам, проверка размера и MD5, статусы commit) |

Работа для MVP:
1. Перенести `lib/sp404.js` в TypeScript-библиотеку по структуре из §6 и добавить тесты кодеков.
2. Ожидание загрузки проекта (`1A`) и периодический опрос статуса (выбор pad'а на SP, working mode).
3. Импорт на занятый pad: последовательность App с `.TMP` (02-files.md) — сейчас запрещено песочницей.
4. Удаление и перемещение сэмплов — только после отдельного эксперимента в песочнице.
5. Сравнить скорость с App; при необходимости проверить конвейерную отправку пачек.
6. Проверить в Edge, на macOS и Linux.

**Статус 2026-10-06: MVP v0.1 работает на железе [Э].** `app/` (Vite + TypeScript + Preact). На реальном SP в Chrome проверено:
- подключение и автоподключение;
- чтение 160 pad'ов;
- пакетный drag & drop с BPM из имени файла;
- волна из локального PCM;
- ввод BPM с клавиатуры (Enter);
- прослушивание на SP.

Найдено и исправлено: `8E` (preview) играет pad, **выбранный на устройстве**, и только потом переключает выбор. Поэтому при каждом выборе pad'а клиент выбирает его и на SP через глобальные параметры `00`/`01` (так делают официальный App и SparkyMK2), а перед `8E` повторяет выбор.

Тестовые сэмплы C1–C5 в проекте 4 (песочница) можно удалить на устройстве или заново загрузить заводской проект.
