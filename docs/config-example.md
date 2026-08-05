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
