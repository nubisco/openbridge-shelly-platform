# Examples

## Minimal

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [{ "ip": "192.168.1.122", "name": "Home" }]
  }
}
```

## Localised phase names, no HomeKit

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [
      {
        "ip": "192.168.1.122",
        "name": "Home",
        "phaseNames": ["Fase A", "Fase B", "Fase C"],
        "exposeToHomeKit": false,
        "pollInterval": 5
      }
    ]
  }
}
```

## Total only, with an alert

Useful when you want one headline number plus a HomeKit notification when the house draws more
than 5 kW:

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [
      {
        "ip": "192.168.1.122",
        "name": "Home",
        "showPhases": false,
        "alertThreshold": 5000
      }
    ]
  }
}
```

## Several meters

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [
      { "ip": "192.168.1.122", "name": "Home" },
      { "ip": "192.168.1.140", "name": "Workshop", "pollInterval": 30 }
    ]
  }
}
```

## A gate

A Shelly with one relay on the gate operator's step input and its limit switches on two inputs.
The relay needs a 500 ms auto-off timer set in the Shelly app, and both inputs need to be in
`Switch` mode and detached from the relays.

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [
      {
        "ip": "192.168.1.201",
        "name": "Driveway",
        "gate": {
          "switch": 0,
          "openInput": 0,
          "closedInput": 1,
          "travelTime": 25
        }
      }
    ]
  }
}
```

See [Gates](/gates) for the wiring and for why reaching a target sometimes takes more than one
pulse.
