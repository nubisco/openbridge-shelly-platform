import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { ShellyEnergyDevice } from '../src/index'

/** A stand-in 3EM whose behaviour the tests can flip at runtime. */
let server: http.Server
let host: string
let failing = false

const STATUS = {
  emeters: [
    { power: 4.15, pf: 0.33, current: 0.1, voltage: 242.85, is_valid: true, total: 224585.1, total_returned: 0 },
    {
      power: 221.66,
      pf: 0.17,
      current: 5.45,
      voltage: 242.77,
      is_valid: true,
      total: 1152277.5,
      total_returned: 45062.3,
    },
    { power: 68.46, pf: 0.81, current: 0.35, voltage: 242.77, is_valid: true, total: 999175.0, total_returned: 830.1 },
  ],
  total_power: 294.27,
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (failing) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    if (req.url === '/shelly') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'SHEM-3', mac: 'C8C9A33E65D6', num_emeters: 3, fw: 'v1.14.0' }))
      return
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(STATUS))
      return
    }
    res.writeHead(404)
    res.end('Not Found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function makeContext() {
  const telemetry: Record<string, Record<string, unknown>> = {}
  const registered: Array<{ id: string; name: string; widgetType: string }> = []
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    telemetry,
    registered,
    log,
    ctx: {
      config: {},
      log,
      reportTelemetry: (id: string, data: Record<string, unknown>) => {
        telemetry[id] = data
      },
      registerDevice: (d: any) => registered.push(d),
      registerControl: vi.fn(),
    } as any,
  }
}

describe('ShellyEnergyDevice', () => {
  it('registers a total plus one device per phase', async () => {
    const { ctx, registered } = makeContext()
    const device = new ShellyEnergyDevice({ ip: host, name: 'Home' }, ctx.log)
    await device.setup(ctx, null, null)

    expect(registered.map((r) => r.name)).toEqual([
      'Home - Total',
      'Home - Phase A',
      'Home - Phase B',
      'Home - Phase C',
    ])
    // Device ids are keyed on MAC, so they survive a DHCP lease change.
    expect(registered.map((r) => r.id)).toEqual([
      'shelly-c8c9a33e65d6-total',
      'shelly-c8c9a33e65d6-p0',
      'shelly-c8c9a33e65d6-p1',
      'shelly-c8c9a33e65d6-p2',
    ])
    expect(registered.every((r) => r.widgetType === 'energy_meter')).toBe(true)
  })

  it('honours custom phase names', async () => {
    const { ctx, registered } = makeContext()
    const device = new ShellyEnergyDevice(
      { ip: host, name: 'Home', phaseNames: ['Fase A', 'Fase B', 'Fase C'] },
      ctx.log,
    )
    await device.setup(ctx, null, null)
    expect(registered.map((r) => r.name)).toContain('Home - Fase A')
  })

  it('can omit the total or the individual phases', async () => {
    const { ctx, registered } = makeContext()
    const device = new ShellyEnergyDevice({ ip: host, name: 'Home', showPhases: false }, ctx.log)
    await device.setup(ctx, null, null)
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('Home - Total')
  })

  it('reports telemetry in the shape the OpenBridge energy UI expects', async () => {
    const { ctx, telemetry } = makeContext()
    const device = new ShellyEnergyDevice({ ip: host, name: 'Home' }, ctx.log)
    await device.setup(ctx, null, null)
    await device.poll(ctx)

    const phaseB = telemetry['shelly-c8c9a33e65d6-p1']
    expect(phaseB).toMatchObject({
      power: 221.66,
      voltage: 242.77,
      current: 5.45,
      powerFactor: 0.17,
      valid: true,
    })
    // totalForwardEnergy drives the history chart and must be in kWh.
    expect(phaseB.totalForwardEnergy).toBe(1152.2775)

    expect(telemetry['shelly-c8c9a33e65d6-total'].power).toBe(294.27)
  })

  it('logs a repeating failure once instead of on every poll', async () => {
    const { ctx, log } = makeContext()
    const device = new ShellyEnergyDevice({ ip: host, name: 'Home' }, ctx.log)
    await device.setup(ctx, null, null)

    failing = true
    await device.poll(ctx)
    await device.poll(ctx)
    await device.poll(ctx)
    failing = false

    // The plugin this replaces logged four errors every ten seconds forever.
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('announces recovery and reports how many errors it swallowed', async () => {
    const { ctx, log } = makeContext()
    const device = new ShellyEnergyDevice({ ip: host, name: 'Home' }, ctx.log)
    await device.setup(ctx, null, null)

    failing = true
    await device.poll(ctx)
    await device.poll(ctx)
    failing = false
    await device.poll(ctx)

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('recovered'))
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('1 repeat'))
  })

  it('refuses to set up a Gen2 device', async () => {
    const { ctx } = makeContext()
    const gen2 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ mac: 'EC6260887F18', model: 'SPSW-202PE16EU', gen: 2, app: 'Pro2PM' }))
    })
    await new Promise<void>((resolve) => gen2.listen(0, '127.0.0.1', resolve))
    const gen2Host = `127.0.0.1:${(gen2.address() as AddressInfo).port}`

    const device = new ShellyEnergyDevice({ ip: gen2Host }, ctx.log)
    await expect(device.setup(ctx, null, null)).rejects.toThrow(/Gen2 device/)

    await new Promise<void>((resolve) => gen2.close(() => resolve()))
  })

  it('does not overlap polls when the device is slow', async () => {
    const { ctx } = makeContext()
    const device = new ShellyEnergyDevice({ ip: host, name: 'Home' }, ctx.log)
    await device.setup(ctx, null, null)

    // Two concurrent polls: the second must return immediately without a
    // second round trip, so a slow meter cannot pile up requests.
    const spy = vi.spyOn(device as any, 'onSuccess')
    await Promise.all([device.poll(ctx), device.poll(ctx)])
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
