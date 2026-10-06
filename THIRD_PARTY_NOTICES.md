# Сторонние компоненты Docker-образа

Nait-AWG поставляет сохранённый официальный серверный Docker-образ AmneziaWG, не собственную реализацию VPN-протокола. Происхождение и контрольные суммы приведены в [bundle/README.md](bundle/README.md).

- AmneziaWG Go-runtime: [исходный проект](https://github.com/amnezia-vpn/amneziawg-go), [текст лицензии MIT](licenses/amneziawg-go-MIT.txt).
- AmneziaWG tools 3.1.20260812: [исходный код указанного релиза](https://github.com/amnezia-vpn/amneziawg-tools/tree/v3.1.20260812), [текст GPL-2.0](licenses/amneziawg-tools-GPL-2.0.txt).
- Серверный Dockerfile AmneziaVPN: [официальный исходник](https://github.com/amnezia-vpn/amnezia-client/blob/dev/client/server_scripts/awg/Dockerfile).
- Образ также содержит Alpine Linux и его пакеты. Архив не изменён: поставляемые внутри слоёв сведения о пакетах и лицензиях сохранены. [Исходники пакетов Alpine](https://gitlab.alpinelinux.org/alpine/aports).

Лицензии сторонних компонентов продолжают действовать. Ссылки и копии лицензий не заменяют обязанности по предоставлению соответствующего исходного кода для компонентов, распространяемых по GPL; их необходимо учитывать при публичной и коммерческой поставке.
