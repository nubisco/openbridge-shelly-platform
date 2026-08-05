# Supported Devices

## Supported today

| Device     | Type     | Channels | Notes                                             |
| ---------- | -------- | -------- | ------------------------------------------------- |
| Shelly 3EM | `SHEM-3` | 3        | Verified against firmware `v1.14.0`               |
| Shelly EM  | `SHEM`   | 2        | Same Gen1 API, channel count read from the device |

## Not yet supported

Gen2 and newer devices speak a completely different API. Where Gen1 serves `/status` and
`/emeter/N`, Gen2+ serves JSON-RPC under `/rpc/`:

```text
Gen1:  GET /status                  → { "emeters": [...], "total_power": 294.27 }
Gen2+: GET /rpc/Shelly.GetStatus    → { "switch:0": { "apower": 0.0, "voltage": 244.5, ... } }
```

Pointing a Gen1 client at a Gen2 device, or the reverse, produces `404 Not Found` on every
single call. This plugin therefore probes `/shelly` before polling and refuses a device it
cannot speak to, with a message naming the generation and model it found:

```text
192.168.1.178 is a Gen2 device (model SPSW-202PE16EU), which speaks the /rpc/ API.
This plugin currently supports Gen1 meters only (type SHEM-3 or SHEM).
```

That is deliberate. The alternative, which several plugins in the wild do, is to retry the
wrong endpoint indefinitely and fill the log with errors that never explain the cause.

Gen2+ support (Pro 3EM, Pro 2PM and other relays) is planned. The client layer is already split
so a Gen2 client can be added alongside the Gen1 one without disturbing it.

## Identifying your device

```bash
curl http://<device-ip>/shelly
```

- A response containing `"type"` is Gen1.
- A response containing `"gen": 2` or higher is Gen2+.
