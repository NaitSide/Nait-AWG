# Сторонние компоненты Docker-образа

Nait-AWG поставляет сохранённый официальный серверный Docker-образ AmneziaWG, не собственную реализацию VPN-протокола. Происхождение и контрольные суммы приведены в [bundle/README.md](bundle/README.md).

- AmneziaWG Go-runtime: [исходный проект](https://github.com/amnezia-vpn/amneziawg-go), [текст лицензии MIT](licenses/amneziawg-go-MIT.txt).
- AmneziaWG tools 3.1.20260812: [исходный код указанного релиза](https://github.com/amnezia-vpn/amneziawg-tools/tree/v3.1.20260812), [текст GPL-2.0](licenses/amneziawg-tools-GPL-2.0.txt).
- Серверный Dockerfile AmneziaVPN: [официальный исходник](https://github.com/amnezia-vpn/amnezia-client/blob/dev/client/server_scripts/awg/Dockerfile).
- Образ также содержит Alpine Linux и его пакеты. Архив не изменён: поставляемые внутри слоёв сведения о пакетах и лицензиях сохранены. [Исходники пакетов Alpine](https://gitlab.alpinelinux.org/alpine/aports).

Лицензии сторонних компонентов продолжают действовать. Ссылки и копии лицензий не заменяют обязанности по предоставлению соответствующего исходного кода для компонентов, распространяемых по GPL; их необходимо учитывать при публичной и коммерческой поставке.

## Данные сетей и генератор сигнатур

Каталог содержит фактические IPv4-подсети из публичных источников Telegram, Google и RIPEstat (AS32934). Источники, даты, границы покрытия и условия RIPEstat перечислены в [документации клиентских политик](docs/client-policies.md#каталог-и-ограничения-маршрутов). MIT-лицензия проекта не приписывается этим ответам поставщиков. Генератор на Node.js реализован независимо по RFC; исходники Pashgen/awg3-webui и Any-Tech-ARCHITECT не копировались.

## Иконки интерфейса

Иконки Lucide (`venetian-mask`, `split`, `refresh-cw`): [исходный проект](https://github.com/lucide-icons/lucide), [лицензия и уведомления об авторских правах](licenses/lucide-LICENSE.txt). SVG-пути взяты из Lucide 1.8.0.

## Домены Госуслуг и Яндекс Карт

Часть фактических доменных имён взята из [RU Direct](https://github.com/kyoresuas/ru-direct), конфигурации government.json и yandex.json, и проверяется через DNS. [MIT](licenses/ru-direct-MIT.txt). Сети AS196747 и AS13238 получены из RIPEstat; применяются те же условия RIPEstat, что для AS32934.
