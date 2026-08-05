# Troubleshooting

## "is a GenN device, which speaks the /rpc/ API"

Your device is Gen2 or newer, which this plugin does not yet poll. See
[Supported Devices](/supported-devices). The device is fine; the plugin is being explicit
rather than failing silently.

## "Timed out after 4000ms contacting ..."

The device did not answer in time. Check in order:

1. Is the IP still correct? `curl http://<ip>/shelly`
2. Is the device on a different VLAN or a guest network that blocks LAN traffic?
3. Is the Wi-Fi signal weak? `/status` reports `wifi_sta.rssi`; below about -80 dBm is poor.

Raise `timeout` if the device is reachable but slow.

## "Authentication required"

The device has HTTP authentication enabled. Add `username` and `password` to its config entry.

## "HTTP 404 for /status"

The device answered but does not serve the Gen1 API at all. Confirm what it is with
`curl http://<ip>/shelly`.

## Errors stop appearing after the first one

That is intentional. A repeating identical failure is logged once, then counted silently, and
a recovery message reports how many were suppressed:

```text
192.168.1.122: recovered (37 repeat(s) suppressed)
```

A device that is simply unplugged should not produce an error line every few seconds forever.

## Devices appear but show no data

Check that the plugin is loaded under `plugins[]` (native mode), not `platforms[]`. Only native
plugins can report telemetry to the OpenBridge devices view.
