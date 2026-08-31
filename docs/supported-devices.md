# Supported Devices

## Supported today

### Gen1 (REST API)

| Device     | Type     | Channels | Notes                                             |
| ---------- | -------- | -------- | ------------------------------------------------- |
| Shelly 3EM | `SHEM-3` | 3        | Verified against firmware `v1.14.0`               |
| Shelly EM  | `SHEM`   | 2        | Same Gen1 API, channel count read from the device |

### Gen2+ (RPC API)

Components are discovered from the device rather than from a model table, so any Gen2+ device
built from `switch` or `em` components works without a code change:

| Component  | Becomes                                   | Notes                                      |
| ---------- | ----------------------------------------- | ------------------------------------------ |
| `switch:N` | A switch device, controllable, plus power | Developed against a Shelly Pro 2PM         |
| `em:N`     | One device per live phase, plus a total   | Pro 3EM and similar; pairs with `emdata:N` |
| `cover:N`  | Nothing, declined with an explanation     | See [Roller covers](#roller-covers)        |

Relay channels are published to HomeKit as plain **switches**. To have one appear as a light or
an outlet, set it in the OpenBridge device inspector. OpenBridge re-applies that choice on every
restart, so it survives a bridge restart in a way that re-typing in the Home app does not. The
plugin deliberately offers no `type` setting of its own, so there is only ever one source of
truth for that decision.

## The two APIs

Where Gen1 serves `/status` and `/emeter/N`, Gen2+ serves JSON-RPC under `/rpc/`:

```text
Gen1:  GET /status                  → { "emeters": [...], "total_power": 294.27 }
Gen2+: GET /rpc/Shelly.GetStatus    → { "switch:0": { "output": true, "apower": 41.2, ... } }
```

Pointing a Gen1 client at a Gen2 device, or the reverse, produces `404 Not Found` on every single
call. The plugin therefore probes `/shelly` (the one endpoint every generation answers) and
picks the client from the reported generation before polling anything.

Gen2 also differs in authentication: it uses HTTP **digest** (SHA-256), not the basic auth Gen1
accepts, so a Gen2 device with a password set answers `401` to a basic header. The plugin
negotiates digest automatically; you only need to set `username` and `password` if the device has
authentication enabled.

## Roller covers

A Pro 2PM can be configured as a roller shutter, pairing its two relays into one motor. The
plugin detects that and registers nothing for the device, logging:

```text
192.168.1.178: configured as a roller cover, which is not supported yet.
Switch the device to relay mode to expose its channels.
```

Exposing the paired relays as independent switches would let you drive the motor both ways at
once. Declining is the honest option until covers are modelled properly, with position and
open/close/stop semantics.

## Identifying your device

```bash
curl http://<device-ip>/shelly
```

- A response containing `"type"` is Gen1.
- A response containing `"gen": 2` or higher is Gen2+.
