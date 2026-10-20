# Nait-AWG

<a href="README.md"><picture><source media="(prefers-color-scheme: dark)" srcset="img/lang-ru.svg"><source media="(prefers-color-scheme: light)" srcset="img/lang-ru-light.svg"><img alt="Русский" src="img/lang-ru-light.svg" width="48" height="26"></picture></a> <a href="README.en.md"><picture><source media="(prefers-color-scheme: dark)" srcset="img/lang-en.svg"><source media="(prefers-color-scheme: light)" srcset="img/lang-en-light.svg"><img alt="English" src="img/lang-en-light.svg" width="48" height="26"></picture></a>

**Version: 0.1.2**

A web panel for managing your own AmneziaWG VPN server.

*(The web interface is available in English. Switch languages on the login screen.)*

![Nait-AWG client list](img/clients.png)

## Installation

You need a VPS running **Ubuntu 24.04** with a public IPv4 address.

Connect to the server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/NaitSide/Nait-AWG/main/install.sh | sudo bash
```

![Language and action selection in the Nait-AWG installer](img/ru/installer.png)

<details>
<summary>Before installing, check that the server's IP and SSH port are reachable at <a href="https://iwtsy.com/">iwtsy.com</a>.</summary>

If your IP is blocked, there's no point continuing with the Nait-AWG installation.

![Example IP and SSH port check on iwtsy.com](img/ru/server-ip-check.png)

</details>

## About the project

I liked wg-easy: a simple, convenient panel where you could see your VPN clients and manage their access. I missed that after switching to AmneziaWG.

I wanted to keep the original AmneziaWG engine and add a straightforward web interface. That's how Nait-AWG started.

> **Public beta.** I haven't found any bugs, but there may still be some.

## What's in the panel

### Creating a client

![VPN client created](img/client-created.png)

Create a client in a couple of clicks and get a config to connect.

### Client traffic

![Client traffic history](img/ru/traffic.png)

See how many gigs each client downloaded or uploaded, and in which month. Click the client's status to open the totals and monthly chart.

### Client profile

![Client notes and Telegram handle](img/ru/profile.png)

Add their Telegram handle and jot down how much they paid and how long that covers.

### Access management

![Confirming that a VPN client should be disabled](img/ru/client-disable.png)

Temporarily disable access and turn it back on later. The config and client record are kept.

![Confirming VPN client deletion](img/ru/client-delete.png)

If access is no longer needed, delete the client. Their config will stop working.

### Configs and QR codes

![Downloading a .conf config for AmneziaWG](img/ru/download-amneziawg.png)

Download a `.conf` config for the AmneziaWG app.

![Downloading a .vpn config for AmneziaVPN](img/ru/download-amneziavpn.png)

Or a `.vpn` config for the AmneziaVPN app.

For each client you create, you can download a config for either the AmneziaVPN app or the AmneziaWG app.

![Multipart AmneziaVPN QR code with the code obscured](img/ru/qr-amneziavpn.png)

If the device is nearby, scan a QR code in either the AmneziaWG app or the AmneziaVPN app.

AmneziaVPN uses a multipart QR code: in the screenshot, the config is split across two QR codes that alternate automatically. Wait until the app reads both parts.

I've checked this on an iPhone — it works. On some Android devices, the AmneziaVPN app's scanner may have trouble reading multipart QR codes. In that case, download the `.vpn` config instead.

### Settings and version checks

![Nait-AWG settings and version checks](img/ru/settings.png)

**Version checks.** The “Check” button shows the published Nait-AWG version and checks the AmneziaWG engine version (`awg-tools` on the developer's site). To update Nait-AWG, run the same installation command in the terminal and choose **option 3**.

**AWG state.** “Running” means the Docker container is running and the web panel can see the engine. To check that the VPN works, connect from any device and look up your IP at [2ip.io](https://2ip.io/).

**Backups.** Save your clients and VPN settings, then restore them on another server. New keys and configs are generated on the new server, so you'll need to send the new configs to your users. The panel's username and password, domain, certificates and system environment aren't included. [Backup contents and migration limits (in Russian)](docs/administration.md#резервная-копия-и-перенос).

**Custom domain.** Connect your own domain to open the web interface without browser certificate warnings.

> **Note:** When accessing the panel by IP with a self-signed certificate, your browser may not offer to save your username and password. On Windows, saving credentials started working for me after I connected a domain.

**Obfuscation.** Choose QUIC, DNS or custom additional packets. Advanced obfuscation settings are in the same section.

**Split tunneling.** Route everything or only selected services through the VPN. General settings can be overridden in a client profile. Download the config or QR code again after changing them. [List sources, limitations and testing](docs/client-policies.md).

**Languages.** Russian and English are available. Switch languages on the login screen.

## Which installer option to choose

If AmneziaWG is already installed through the AmneziaVPN app, choose **option 1** to add just the web panel. For a fresh server, choose **option 2** to install AmneziaWG and the panel. At the end, you'll get the panel URL, username and password.

## If you installed AmneziaWG through the AmneziaVPN app

You can view existing clients' status and traffic, disable them or delete them. But you can't download their configs again: that requires the client's private key, and AmneziaVPN only sends the public key to the server. The administrator's app doesn't keep the original configs issued to clients for later downloads.

If you still have the config, click the orange exclamation mark next to the client's status and upload the `.conf` or `.vpn` file. Config downloads and QR codes will then become available.

## Updating

When a new Nait-AWG version is released, run the same installation command in the terminal. After selecting a language, choose **option 3 — “Update the Nait-AWG web panel”**. Your clients and settings will be kept. This option updates the web panel; it doesn't update the AmneziaWG engine.

> When an AmneziaWG engine update is released, I'll add a separate installer option for it. There isn't one yet.

[Changelog (in Russian)](CHANGELOG.md) · [Detailed guide (in Russian)](docs/administration.md) · [Third-party components (in Russian)](THIRD_PARTY_NOTICES.md)
