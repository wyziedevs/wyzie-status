# wyzie-status

Monitors wyzie services every 5 seconds and serves live stats on port 4389.

No dependencies. Pure Node.js.

## What it monitors

| Service | URL |
|---|---|
| Subs API root | `https://sub.wyzie.io/` |
| Subs API search | `https://sub.wyzie.io/search?id=tt3659388` |
| Wyzie API health | `https://api.wyzie.io/health` |
| wyzie-lib npm | `https://registry.npmjs.org/wyzie-lib/latest` |

## Run

```sh
node index.js
```

Dashboard: `http://your-vps:4389/`  
Raw JSON: `http://your-vps:4389/data`

## Run as a systemd service (Linux VPS)

Create `/etc/systemd/system/wyzie-status.service`:

```ini
[Unit]
Description=wyzie-status monitor
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/wyzie-status
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Then:

```sh
systemctl daemon-reload
systemctl enable --now wyzie-status
journalctl -fu wyzie-status
```
