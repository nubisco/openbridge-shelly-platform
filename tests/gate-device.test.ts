import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { ShellyGen2Device } from '../src/index'

/**
 * A stand-in Shelly Plus Uni wired to a gate control board: one relay on the
 * board's step input, two inputs tapped off its limit switches.
 */
let server: http.Server
let host: string
let openLimit = false
let closedLimit = true
let autoOff = true
let inputInvert: Record<number, boolean> = { 0: true, 1: true }
let inputType = 'switch'
let relayOutput = false
const setCalls: string[] = []

const status = () => ({
  'switch:0': { id: 0, output: relayOutput, apower: 0 },
  // The Uni's second relay, left for something else entirely.
  'switch:1': { id: 1, output: false },
  'input:0': { id: 0, state: openLimit },
  'input:1': { id: 1, state: closedLimit },
  sys: { uptime: 4242 },
})

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url === '/shelly') return json({ gen: 2, model: 'SNSN-0043X', mac: 'AABBCCDDEEFF' })
    if (url.startsWith('/rpc/Shelly.GetDeviceInfo')) {
      return json({ gen: 2, model: 'SNSN-0043X', mac: 'AABBCCDDEEFF', fw_id: '1.4.4' })
    }
    if (url.startsWith('/rpc/Shelly.GetStatus')) return json(status())
    if (url.startsWith('/rpc/Switch.GetConfig')) {
      return json({ id: 0, auto_off: autoOff, auto_off_delay: 0.5 })
    }
    if (url.startsWith('/rpc/Input.GetConfig')) {
      const id = Number(new URL(url, 'http://x').searchParams.get('id'))
      return json({ id, type: inputType, invert: inputInvert[id] ?? false })
    }
    if (url.startsWith('/rpc/Switch.Set')) {
      setCalls.push(url)
      return json({ was_on: false })
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
  openLimit = false
  closedLimit = true
  autoOff = true
  inputInvert = { 0: true, 1: true }
  inputType = 'switch'
  relayOutput = false
  setCalls.length = 0
})

function makeContext() {
  const telemetry: Record<string, Record<string, unknown>> = {}
  const registered: Array<{ id: string; name: string; widgetType: string }> = []
  const controls: Array<{ deviceId: string; controlId: string; handler: (v: unknown) => unknown }> = []
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    telemetry,
    registered,
    controls,
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
    } as any,
  }
}

const gateConfig = (extra: Record<string, unknown> = {}) => ({
  ip: host,
  name: 'Home',
  'switch:1': { exclude: true },
  gate: { openInput: 0, closedInput: 1, switch: 0, pulseGap: 2, ...extra },
})

async function setupGate(extra: Record<string, unknown> = {}) {
  const c = makeContext()
  const device = new ShellyGen2Device(gateConfig(extra) as any, c.ctx.log)
  await device.setup(c.ctx, null, null)
  return { ...c, device }
}

describe('gate setup', () => {
  it('registers the gate as one device instead of a relay and two inputs', async () => {
    const { registered } = await setupGate()

    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ id: 'shelly-aabbccddeeff-gate', name: 'Home - Gate', widgetType: 'gate' })
  })

  it('takes a name of its own', async () => {
    const { registered } = await setupGate({ name: 'Driveway' })
    expect(registered[0].name).toBe('Driveway')
  })

  it('does not also expose the step relay as a switch', async () => {
    const { registered } = await setupGate()

    // A switch tile that pulses the gate behind the gate accessory's back
    // would leave the two disagreeing about where it is.
    expect(registered.some((d) => d.id.includes('switch'))).toBe(false)
  })

  it('still exposes relays the gate does not use', async () => {
    const c = makeContext()
    const device = new ShellyGen2Device({ ip: host, name: 'Home', gate: { switch: 0 } } as any, c.ctx.log)
    await device.setup(c.ctx, null, null)

    expect(c.registered.map((d) => d.widgetType).sort()).toEqual(['gate', 'switch'])
    expect(c.registered.find((d) => d.widgetType === 'switch')?.id).toBe('shelly-aabbccddeeff-switch1')
  })

  it('warns when the step relay has no auto-off timer', async () => {
    autoOff = false
    const { log } = await setupGate()

    // Without it the relay stays closed across the board's step input, and the
    // gate stops answering its own remote.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('auto-off'))
  })

  it('warns when the two limit inputs disagree about inversion', async () => {
    // One matched pair of limit switches read two different ways round. The
    // gate then reports a position it is not in, and every symptom points at
    // the gate rather than at a checkbox in the Shelly app.
    inputInvert = { 0: true, 1: false }
    const { log } = await setupGate()

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('invert'))
  })

  it('says nothing when both limit inputs agree', async () => {
    const { log } = await setupGate()
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('invert'))
  })

  it('warns when a limit input is not in switch mode', async () => {
    inputType = 'button'
    const { log } = await setupGate()
    // A button reports events, not a level, so the limit is never readable.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('switch" mode'))
  })

  it('refuses a gate whose two limit inputs are the same input', async () => {
    const { registered, log } = await setupGate({ closedInput: 0 })

    expect(registered.some((d) => d.widgetType === 'gate')).toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('must be different'))
  })

  it('refuses a gate pointed at components the device does not have', async () => {
    const { registered, log } = await setupGate({ closedInput: 5 })

    expect(registered.some((d) => d.widgetType === 'gate')).toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('input:5'))
  })

  it('falls back to a plain relay when the gate wiring is unusable', async () => {
    const { registered } = await setupGate({ closedInput: 5 })

    // Better a switch that pulses the board than a device that does nothing:
    // the error line says what to fix, and the relay still works meanwhile.
    expect(registered.map((d) => d.id)).toEqual(['shelly-aabbccddeeff-switch0'])
  })

  it('polls a gate every second by default', async () => {
    const { device } = await setupGate()
    // The five-second default would lag a gate by most of its travel.
    expect(device.pollIntervalMs).toBe(1000)
  })

  it('still honours an explicit poll interval', async () => {
    const c = makeContext()
    const device = new ShellyGen2Device({ ...gateConfig(), pollInterval: 4 } as any, c.ctx.log)
    await device.setup(c.ctx, null, null)
    expect(device.pollIntervalMs).toBe(4000)
  })
})

describe('gate polling', () => {
  it('reports the position read from the limit switches', async () => {
    const { ctx, device, telemetry } = await setupGate()
    await device.poll(ctx)

    expect(telemetry['shelly-aabbccddeeff-gate']).toMatchObject({
      state: 'closed',
      target: 'closed',
      openLimit: false,
      closedLimit: true,
      wiringFault: false,
    })
  })

  it('follows a gate opened by its remote, with nobody having asked', async () => {
    const { ctx, device, telemetry } = await setupGate()
    await device.poll(ctx)

    closedLimit = false
    await device.poll(ctx)
    expect(telemetry['shelly-aabbccddeeff-gate'].state).toBe('opening')

    openLimit = true
    await device.poll(ctx)
    expect(telemetry['shelly-aabbccddeeff-gate'].state).toBe('open')
    expect(setCalls).toHaveLength(0)
  })

  it('flags both limits reading high as a wiring fault', async () => {
    const { ctx, device, telemetry } = await setupGate()
    await device.poll(ctx)

    openLimit = true
    await device.poll(ctx)
    expect(telemetry['shelly-aabbccddeeff-gate'].wiringFault).toBe(true)
  })

  it('reads inverted sensing the other way round', async () => {
    const { ctx, device, telemetry } = await setupGate({ invertInputs: true })
    // Inverted: input:1 high now means "not at the closed limit".
    await device.poll(ctx)
    expect(telemetry['shelly-aabbccddeeff-gate']).toMatchObject({ state: 'open', openLimit: true })
  })

  it('includes the gate in the ids it registered', async () => {
    const { device } = await setupGate()
    expect(device.deviceIds).toEqual(['shelly-aabbccddeeff-gate'])
  })
})

describe('gate control', () => {
  it('registers a target control and a raw step control', async () => {
    const { controls } = await setupGate()
    expect(controls.map((c) => c.controlId)).toEqual(['target', 'step'])
  })

  it('pulses the step relay once to open a closed gate', async () => {
    const { ctx, device, controls, telemetry } = await setupGate()
    await device.poll(ctx)

    await controls[0].handler('open')
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toContain('id=0')
    expect(setCalls[0]).toContain('on=true')
    // One call, not on-then-off: the device's auto-off ends the pulse.
    expect(setCalls.every((c) => c.includes('on=true'))).toBe(true)
    expect(telemetry['shelly-aabbccddeeff-gate'].state).toBe('opening')
  })

  it('does not pulse a gate that is already where it was asked to be', async () => {
    const { ctx, device, controls } = await setupGate()
    await device.poll(ctx)

    await controls[0].handler('closed')
    expect(setCalls).toHaveLength(0)
  })

  it('takes two pulses to reverse a moving gate', async () => {
    const { ctx, device, controls } = await setupGate()
    await device.poll(ctx)
    await controls[0].handler('open')
    setCalls.length = 0

    await controls[0].handler('closed')
    expect(setCalls).toHaveLength(2)
  })

  it('steps the board once on the raw step control', async () => {
    const { ctx, device, controls } = await setupGate()
    await device.poll(ctx)

    await controls[1].handler(null)
    expect(setCalls).toHaveLength(1)
  })

  it('accepts a boolean target, as a UI toggle sends', async () => {
    const { ctx, device, controls, telemetry } = await setupGate()
    await device.poll(ctx)

    await controls[0].handler(true)
    expect(telemetry['shelly-aabbccddeeff-gate'].state).toBe('opening')
  })

  it('stops its travel timer when the device runner stops', async () => {
    const { ctx, device, controls } = await setupGate({ travelTime: 1 })
    await device.poll(ctx)
    await controls[0].handler('open')

    // A gate left mid-travel must not keep a timer alive after shutdown.
    expect(() => device.stop()).not.toThrow()
  })
})

describe('gate telemetry shape', () => {
  it('reports the same fields whether a poll or a command caused the change', async () => {
    const { ctx, device, controls, telemetry } = await setupGate()
    await device.poll(ctx)
    const fromPoll = Object.keys(telemetry['shelly-aabbccddeeff-gate']).sort()

    await controls[0].handler('open')
    const fromCommand = Object.keys(telemetry['shelly-aabbccddeeff-gate']).sort()

    // Anything reading this must not have to cope with two shapes depending on
    // who moved the gate.
    expect(fromCommand).toEqual(fromPoll)
  })
})

describe('a step relay that will not open', () => {
  it('leaves a single poll alone, which can land inside a real pulse', async () => {
    const { ctx, device } = await setupGate()
    relayOutput = true
    await device.poll(ctx)

    // Polls are a second apart and a pulse is half of one, so one sighting
    // proves nothing.
    expect(setCalls.filter((c) => c.includes('on=false'))).toHaveLength(0)
  })

  it('opens it after two polls, because the auto-off plainly did not fire', async () => {
    const { ctx, device } = await setupGate()
    relayOutput = true
    await device.poll(ctx)
    await device.poll(ctx)
    await new Promise((r) => setTimeout(r, 50))

    // A held step input makes the operator ignore its own handset, so nobody
    // can open the gate until this is released.
    const off = setCalls.filter((c) => c.includes('on=false'))
    expect(off).toHaveLength(1)
    expect(off[0]).toContain('id=0')
  })

  it('says what it saw and what it did', async () => {
    const { ctx, device, log } = await setupGate()
    relayOutput = true
    await device.poll(ctx)
    await device.poll(ctx)
    // The release is fired without being awaited, so let it land rather than
    // leaving it to arrive during the next test.
    await new Promise((r) => setTimeout(r, 50))
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('stayed closed'))
  })

  it('forgets the count once the relay opens again', async () => {
    const { ctx, device } = await setupGate()
    relayOutput = true
    await device.poll(ctx)
    relayOutput = false
    await device.poll(ctx)
    relayOutput = true
    await device.poll(ctx)
    await new Promise((r) => setTimeout(r, 50))

    // The second sighting has to be consecutive, or a gate pulsed once a
    // second would be read as latched.
    expect(setCalls.filter((c) => c.includes('on=false'))).toHaveLength(0)
  })
})
