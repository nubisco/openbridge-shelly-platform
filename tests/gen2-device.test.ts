import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { ShellyGen2Device } from '../src/index'

/** A stand-in Pro 2PM whose profile and health the tests flip at runtime. */
let server: http.Server
let host: string
let failing = false
let coverMode = false
const setCalls: string[] = []
const rebootCalls: string[] = []

const SWITCH_STATUS = {
  'switch:0': { id: 0, output: true, apower: 41.2, voltage: 232.1, current: 0.18, aenergy: { total: 12045.6 } },
  'switch:1': { id: 1, output: false, apower: 0, voltage: 232.4, current: 0, aenergy: { total: 880.2 } },
  sys: { uptime: 4242 },
}

const COVER_STATUS = { 'cover:0': { id: 0, state: 'stopped', current_pos: 50 } }

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    if (failing) {
      res.writeHead(500)
      res.end('boom')
      return
    }
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // Both clients probe here: the plugin dispatches on `gen` before choosing.
    if (url === '/shelly') return json({ gen: 2, model: 'SPSW-002PE16EU', mac: 'EC6260887F18' })
    if (url.startsWith('/rpc/Shelly.GetDeviceInfo')) {
      return json({ gen: 2, model: 'SPSW-002PE16EU', mac: 'EC6260887F18', fw_id: '1.3.0' })
    }
    if (url.startsWith('/rpc/Shelly.GetStatus')) return json(coverMode ? COVER_STATUS : SWITCH_STATUS)
    if (url.startsWith('/rpc/Switch.Set')) {
      setCalls.push(url)
      return json({ was_on: false })
    }
    if (url.startsWith('/rpc/Shelly.Reboot')) {
      rebootCalls.push(url)
      return json(null)
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

beforeEach(() => {
  failing = false
  coverMode = false
  setCalls.length = 0
  rebootCalls.length = 0
})

function makeContext() {
  const telemetry: Record<string, Record<string, unknown>> = {}
  const registered: Array<{ id: string; name: string; widgetType: string; actions?: any[] }> = []
  const controls: Array<{ deviceId: string; controlId: string; handler: (v: unknown) => unknown }> = []
  const events: Array<{ deviceId: string; type: string; message: string }> = []
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    telemetry,
    registered,
    controls,
    events,
    log,
    ctx: {
      config: {},
      log,
      reportTelemetry: (id: string, data: Record<string, unknown>) => {
        telemetry[id] = data
      },
      registerDevice: (d: any) => registered.push(d),
      registerControl: (deviceId: string, controlId: string, handler: any) =>
        controls.push({ deviceId, controlId, handler }),
      recordEvent: (deviceId: string, e: any) => events.push({ deviceId, ...e }),
    } as any,
  }
}

describe('ShellyGen2Device setup', () => {
  it('registers one switch device per relay channel', async () => {
    const { ctx, registered } = makeContext()
    const device = new ShellyGen2Device({ ip: host, name: 'Pool' } as any, ctx.log)
    await device.setup(ctx, null, null)

    expect(registered).toHaveLength(2)
    expect(registered.map((d) => d.widgetType)).toEqual(['switch', 'switch'])
    expect(registered.map((d) => d.name)).toEqual(['Pool - Switch 0', 'Pool - Switch 1'])
  })

  it('registers an "active" control per relay that actuates the device', async () => {
    const { ctx, controls } = makeContext()
    const device = new ShellyGen2Device({ ip: host } as any, ctx.log)
    await device.setup(ctx, null, null)

    // This control is what makes the toggle in the OpenBridge devices view work.
    expect(controls.map((c) => c.controlId)).toEqual(['reboot', 'active', 'reboot', 'active'])

    await controls.filter((c) => c.controlId === 'active')[1].handler(true)
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toContain('id=1')
    expect(setCalls[0]).toContain('on=true')
  })

  it('offers a reboot on every channel, and says it takes the whole box down', async () => {
    const { ctx, registered, controls, events } = makeContext()
    const device = new ShellyGen2Device({ ip: host } as any, ctx.log)
    await device.setup(ctx, null, null)

    // Declared per device, because OpenBridge shows one Shelly's channels as
    // separate devices and the button has to be on whichever one is open.
    for (const d of registered) {
      expect(d.actions?.map((a: any) => a.id)).toEqual(['reboot'])
    }

    // The confirmation has to say the part the button cannot: this is not
    // scoped to the channel whose inspector you are looking at.
    const action = registered[0].actions[0]
    expect(action.confirm).toMatch(/whole Shelly/i)
    expect(action.confirm).toMatch(/every channel/i)

    await controls.filter((c) => c.controlId === 'reboot')[0].handler(true)
    expect(rebootCalls).toHaveLength(1)

    // On the timeline before the device goes away, so the outage that follows
    // has a cause next to it rather than looking like a fault.
    expect(events.some((e) => e.type === 'reboot')).toBe(true)
  })

  it('honours a per-channel name override', async () => {
    const { ctx, registered } = makeContext()
    const config = { ip: host, name: 'Pool', 'switch:0': { name: 'Pool Light' } }
    const device = new ShellyGen2Device(config as any, ctx.log)
    await device.setup(ctx, null, null)

    expect(registered[0].name).toBe('Pool Light')
    expect(registered[1].name).toBe('Pool - Switch 1')
  })

  it('skips an excluded channel', async () => {
    const { ctx, registered } = makeContext()
    const config = { ip: host, name: 'Pool', 'switch:1': { exclude: true } }
    const device = new ShellyGen2Device(config as any, ctx.log)
    await device.setup(ctx, null, null)

    expect(registered.map((d) => d.id)).toEqual(['shelly-ec6260887f18-switch0'])
  })

  it('declines a device wired as a roller cover instead of half-registering it', async () => {
    coverMode = true
    const { ctx, registered, log } = makeContext()
    const device = new ShellyGen2Device({ ip: host } as any, ctx.log)
    await device.setup(ctx, null, null)

    // Exposing the paired relays independently would let the user drive the
    // motor both ways at once.
    expect(registered).toHaveLength(0)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('roller cover'))
  })

  it('ignores components that carry no device-level meaning', async () => {
    const { ctx, registered } = makeContext()
    const device = new ShellyGen2Device({ ip: host } as any, ctx.log)
    await device.setup(ctx, null, null)

    // "sys" is in the status payload but must not become an OpenBridge device.
    expect(registered.every((d) => d.id.includes('switch'))).toBe(true)
  })
})

describe('ShellyGen2Device polling', () => {
  it('reports relay state and per-channel power', async () => {
    const { ctx, telemetry } = makeContext()
    const device = new ShellyGen2Device({ ip: host, name: 'Pool' } as any, ctx.log)
    await device.setup(ctx, null, null)
    await device.poll(ctx)

    expect(telemetry['shelly-ec6260887f18-switch0']).toMatchObject({
      active: true,
      power: 41.2,
      voltage: 232.1,
      totalForwardEnergy: 12.0456,
    })
    expect(telemetry['shelly-ec6260887f18-switch1']).toMatchObject({ active: false, power: 0 })
  })

  it('never throws when the device fails, so one bad device cannot stop the plugin', async () => {
    const { ctx, log } = makeContext()
    const device = new ShellyGen2Device({ ip: host } as any, ctx.log)
    await device.setup(ctx, null, null)

    failing = true
    await expect(device.poll(ctx)).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalled()
  })

  it('logs a repeating failure once, then counts repeats silently', async () => {
    const { ctx, log } = makeContext()
    const device = new ShellyGen2Device({ ip: host } as any, ctx.log)
    await device.setup(ctx, null, null)

    failing = true
    await device.poll(ctx)
    await device.poll(ctx)
    await device.poll(ctx)

    // An unplugged device must not produce an error line every poll forever.
    expect(log.error).toHaveBeenCalledTimes(1)

    failing = false
    await device.poll(ctx)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('recovered'))
  })

  it('exposes the ids it registered', async () => {
    const { ctx } = makeContext()
    const device = new ShellyGen2Device({ ip: host } as any, ctx.log)
    await device.setup(ctx, null, null)

    expect(device.deviceIds).toEqual(['shelly-ec6260887f18-switch0', 'shelly-ec6260887f18-switch1'])
    expect(device.deviceInfo?.gen).toBe(2)
  })
})
