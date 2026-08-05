# Installation

## From the OpenBridge marketplace

Search for **Shelly Platform** in the OpenBridge plugins page and install it. This is the
recommended route: OpenBridge handles installation, updates and configuration UI for you.

## From npm

```bash
npm install -g @nubisco/openbridge-shelly-platform
```

## Requirements

- Node.js 20 or newer
- OpenBridge with native plugin support
- A Shelly energy meter reachable on your local network

## Finding your device

Every Shelly, of every generation, answers `/shelly`. It is the quickest way to confirm both
the address and the model:

```bash
curl http://192.168.1.122/shelly
```

A Gen1 3EM answers like this:

```json
{ "type": "SHEM-3", "mac": "C8C9A33E65D6", "auth": false, "fw": "20230913-114244/v1.14.0-gcb84623", "num_emeters": 3 }
```

The `type` field means Gen1. A device answering with `gen` and `model` instead is Gen2 or newer
and is not yet polled by this plugin.
