# lg-tv-matter-remote

Exposes an LG webOS TV (tested target: OLED55B9, webOS 4.5) as a Matter **dimmable light**, so it can be added to
any Matter controller:

- **On/Off** → TV power (Wake-on-LAN to turn on, `ssap://system/turnOff` to turn off)
- **Brightness** → the TV's _OLED Light_ picture setting (0–100)

Changes made with the TV remote are synced back to the controller.

Matter's TV device types (Basic/Casting Video Player) have no brightness control and are supported by few
controllers, so the TV shows up as a dimmable light instead.

## Requirements

- Node.js 24+ (runs the TypeScript sources natively, no build step)
- The machine running this must be on the same network as the TV and the Matter controller (IPv6/mDNS must work)

## TV setup

1. Give the TV a fixed IP address (DHCP reservation in your router).
2. _Settings → All Settings → General → Mobile TV On → Turn on via Wi-Fi_ (or LAN): **on**.
   A wired connection is the most reliable for Wake-on-LAN.
3. _Settings → All Settings → Connection → LG Connect Apps_: **on**.

## Usage

```bash
npm install
cp .env.example .env # then set TV_HOST and TV_MAC
```

Pair with the TV once (the TV must be on, accept the prompt shown on screen):

```bash
npm run tv -- pair
```

Test the TV control without Matter:

```bash
npm run tv -- status
npm run tv -- off
npm run tv -- on
npm run tv -- brightness 40
```

Start the Matter device:

```bash
npm start
```

On first start a QR code and a manual pairing code are printed. Add a Matter device in your controller's app and scan
the QR code or enter the manual code. The device uses a test vendor ID, so the app may warn that it is not certified.

The TV client key and the Matter fabric data are stored in `./data` (configurable with `DATA_DIR`). Delete
`data/matter` to reset the Matter pairing.

## Docker

The container must use **host networking**: Matter relies on mDNS (multicast) and IPv6 link-local addresses, and
Wake-on-LAN uses UDP broadcasts, none of which work through Docker's bridge network. Host networking is only
supported on Linux hosts (e.g. a Raspberry Pi or a NAS), not on Docker Desktop for macOS/Windows.

`compose.yaml`:

```yaml
services:
  lg-tv-matter-remote:
    image: ghcr.io/lpgera/lg-tv-matter-remote:latest
    # or build from a checkout of this repository:
    # build: .
    container_name: lg-tv-matter-remote
    restart: unless-stopped
    network_mode: host
    environment:
      TV_HOST: 192.168.1.50
      TV_MAC: aa:bb:cc:dd:ee:ff
      MATTER_LOG_LEVEL: info
    volumes:
      - data:/app/data

volumes:
  data:
```

Pair with the TV first (the TV must be on, accept the prompt on screen), then start the service:

```bash
docker compose run --rm lg-tv-matter-remote node src/cli.ts pair
```

```bash
docker compose up -d
```

The pairing QR code and manual pairing code are printed to the logs:

```bash
docker compose logs -f
```

The other CLI commands work the same way, e.g. `docker compose run --rm lg-tv-matter-remote node src/cli.ts status`.

The `data` volume holds the TV client key and the Matter pairing, keep it to avoid re-pairing when the container is
recreated. If you prefer a bind mount (e.g. `./data:/app/data`), make sure the directory is writable by UID 1000, which
the container runs as.

## Configuration

See [.env.example](.env.example). `MATTER_LOG_LEVEL` (`debug`, `info`, `notice`, `warn`, `error`) controls the
matter.js log output.

## How brightness is set

webOS no longer allows writing picture settings through the public SSAP API. Like
[aiopylgtv](https://github.com/bendavid/aiopylgtv) and [bscpylgtv](https://github.com/chros73/bscpylgtv), this project
creates a system alert whose close action is a luna call to `com.webos.settingsservice/setSystemSettings` and closes
it immediately. The picture setting key (`backlight` or `oledLight`) is auto-detected; override it with
`TV_BRIGHTNESS_KEY` if needed. The setting applies to the current picture mode.

## Development

```bash
npm run typecheck
```

Only erasable TypeScript syntax is allowed (no enums, namespaces or parameter properties), and relative imports use
the `.ts` extension.
