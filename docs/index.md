---
layout: home

hero:
  name: OpenBridge Shelly
  text: Local Energy Monitoring
  tagline: Per-phase power, voltage, current and energy from your Shelly meters, read locally over your own network.
  actions:
    - theme: brand
      text: Get Started
      link: ./installation
    - theme: alt
      text: Introduction
      link: ./introduction
    - theme: alt
      text: GitHub
      link: https://github.com/nubisco/openbridge-shelly-platform
  image:
    src: /logo.svg
    alt: OpenBridge Shelly Platform

features:
  - icon:
      src: /openbridge.svg
    title: OpenBridge Native
    details: Reports real measurements with real units straight to OpenBridge, instead of smuggling watts through a HomeKit light sensor.
  - icon:
      src: /privacy.svg
    title: 100% Local LAN
    details: Talks directly to the device on your network. No cloud account, no Shelly servers, no internet dependency.
  - icon:
      src: /lightning.svg
    title: Per-Phase Telemetry
    details: Every phase becomes its own device, with power, voltage, current, power factor and cumulative energy.
  - icon:
      src: /device.svg
    title: Energy History
    details: Readings are recorded to OpenBridge history, giving charts per phase from ten-second detail out to five years.
  - icon:
      src: /protocol.svg
    title: Generation Aware
    details: Probes the device before polling and says exactly what it found, instead of retrying the wrong API forever.
  - icon:
      src: /handshake.svg
    title: HomeKit Optional
    details: Expose a meter to the Home app or hide it. OpenBridge telemetry and history are unaffected either way.
  - icon:
      src: /bulb.svg
    title: Honest Units
    details: Cumulative energy is converted from watt-hours to kilowatt-hours at a single boundary, covered by tests.
  - icon:
      src: /device.svg
    title: Shelly 3EM and EM
    details: Gen1 energy meters supported today, verified against firmware v1.14.0. Gen2+ devices are detected and reported clearly.
---
