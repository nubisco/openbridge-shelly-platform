import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { createHash } from 'crypto'
import { ShellyProtocolError } from '../src/protocol/ShellyGen1Client'
import {
  ShellyGen2Client,
  assertGen2,
  isCoverMode,
  parseChallenge,
  parseComponents,
  toEmPhaseReading,
  toEmTotalReading,
  toSwitchReading,
} from '../src/protocol/ShellyGen2Client'

/**
 * A stand-in Pro 2PM served over real HTTP, so the client is exercised through
 * the same socket path it uses in production rather than a mocked module.
 */
let server: http.Server
let host: string

/** Flipped by tests to exercise the auth and error branches. */
let requireAuth = false
let lastAuthorization: string | undefined
const setCalls: string[] = []

const DEVICE_INFO = {
  name: 'Pool',
  id: 'shellypro2pm-ec6260887f18',
  mac: 'EC6260887F18',
  model: 'SPSW-002PE16EU',
  gen: 2,
  fw_id: '20240425-141520/1.3.0',
  profile: 'switch',
}

const STATUS = {
  'switch:0': {
    id: 0,
    output: true,
    apower: 41.2,
    voltage: 232.1,
    current: 0.18,
    aenergy: { total: 12045.6 },
  },
  'switch:1': { id: 1, output: false, apower: 0, voltage: 232.4, current: 0, aenergy: { total: 880.2 } },
  sys: { uptime: 4242 },
  wifi: { status: 'got ip' },
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''

    if (requireAuth && !req.headers.authorization) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Digest qop="auth", realm="shellypro2pm-ec6260887f18", nonce="abc123", algorithm=SHA-256',
      })
      res.end()
      return
    }
    lastAuthorization = req.headers.authorization

    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.startsWith('/rpc/Shelly.GetDeviceInfo')) return json(DEVICE_INFO)
    if (url.startsWith('/rpc/Shelly.GetStatus')) return json(STATUS)
    if (url.startsWith('/rpc/Switch.Set')) {
      setCalls.push(url)
      return json({ was_on: false })
    }
    if (url.startsWith('/rpc/Broken.Call')) return json({ error: { code: -105, message: 'Argument id is missing' } })
    if (url.startsWith('/rpc/Garbage')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('not json')
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => server.close())

describe('ShellyGen2Client', () => {
  it('reads device info over the RPC endpoint', async () => {
    const info = await new ShellyGen2Client(host).getDeviceInfo()
    expect(info.gen).toBe(2)
    expect(info.model).toBe('SPSW-002PE16EU')
  })

  it('returns every component from a single status call', async () => {
    const status = await new ShellyGen2Client(host).getStatus()
    expect(Object.keys(status)).toContain('switch:0')
    expect(Object.keys(status)).toContain('switch:1')
  })

  it('actuates a relay by id', async () => {
    setCalls.length = 0
    await new ShellyGen2Client(host).setSwitch(1, true)
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toContain('id=1')
    expect(setCalls[0]).toContain('on=true')
  })

  it('surfaces an RPC error returned with a 200 status', async () => {
    // Gen2 reports call errors in the body rather than the status line, so a
    // client that only checks statusCode would treat this as success.
    const client = new ShellyGen2Client(host)
    await expect((client as any).call('Broken.Call')).rejects.toThrow(ShellyProtocolError)
  })

  it('reports unparseable bodies rather than throwing a syntax error', async () => {
    const client = new ShellyGen2Client(host)
    await expect((client as any).call('Garbage')).rejects.toThrow(/Invalid JSON/)
  })

  it('reports a 404, which is what a Gen1 device answers to /rpc/', async () => {
    const client = new ShellyGen2Client(host)
    await expect((client as any).call('Nope.Missing')).rejects.toThrow(/HTTP 404/)
  })
})

describe('digest authentication', () => {
  it('answers a challenge and retries with a SHA-256 digest response', async () => {
    requireAuth = true
    lastAuthorization = undefined
    try {
      const client = new ShellyGen2Client(host, { username: 'admin', password: 'secret' })
      const info = await client.getDeviceInfo()
      expect(info.gen).toBe(2)

      // Gen1 uses basic auth; sending that here would 401 forever.
      expect(lastAuthorization).toMatch(/^Digest /)
      expect(lastAuthorization).toContain('algorithm=SHA-256')
      expect(lastAuthorization).toContain('username="admin"')

      // Verify the response hash is actually correct, not merely present.
      const uri = '/rpc/Shelly.GetDeviceInfo'
      const nonce = /nonce="([^"]+)"/.exec(lastAuthorization!)![1]
      const cnonce = /cnonce="([^"]+)"/.exec(lastAuthorization!)![1]
      const nc = /nc=([^,]+)/.exec(lastAuthorization!)![1]
      const sha = (v: string) => createHash('sha256').update(v).digest('hex')
      const expected = sha(
        `${sha('admin:shellypro2pm-ec6260887f18:secret')}:${nonce}:${nc}:${cnonce}:auth:${sha(`GET:${uri}`)}`,
      )
      expect(lastAuthorization).toContain(`response="${expected}"`)
    } finally {
      requireAuth = false
    }
  })

  it('explains itself when the device demands auth and no credentials are set', async () => {
    requireAuth = true
    try {
      await expect(new ShellyGen2Client(host).getStatus()).rejects.toThrow(/Authentication required/)
    } finally {
      requireAuth = false
    }
  })
})

describe('parseChallenge', () => {
  it('pulls realm, nonce and qop out of the header', () => {
    const c = parseChallenge('Digest qop="auth", realm="shelly", nonce="xyz", algorithm=SHA-256')
    expect(c).toEqual({ realm: 'shelly', nonce: 'xyz', qop: 'auth' })
  })

  it('defaults qop when the device omits it', () => {
    expect(parseChallenge('Digest realm="shelly", nonce="xyz"')?.qop).toBe('auth')
  })

  it('ignores a non-digest scheme', () => {
    expect(parseChallenge('Basic realm="shelly"')).toBeNull()
    expect(parseChallenge(undefined)).toBeNull()
  })
})

describe('parseComponents', () => {
  it('finds indexed components and ignores the rest', () => {
    // sys and wifi carry no device-level meaning and must not become devices.
    expect(parseComponents(STATUS).map((c) => c.key)).toEqual(['switch:0', 'switch:1'])
  })

  it('handles an empty or absent status without throwing', () => {
    expect(parseComponents({})).toEqual([])
    expect(parseComponents(undefined as never)).toEqual([])
  })

  it('reads the channel index out of the key', () => {
    expect(parseComponents({ 'switch:3': {} })[0]).toEqual({ type: 'switch', index: 3, key: 'switch:3' })
  })
})

describe('isCoverMode', () => {
  it('detects a device wired as a roller shutter', () => {
    expect(isCoverMode({ 'cover:0': {} })).toBe(true)
  })

  it('is false for a relay-mode device', () => {
    expect(isCoverMode(STATUS)).toBe(false)
  })
})

describe('assertGen2', () => {
  it('accepts a Gen2 device', () => {
    expect(() => assertGen2({ gen: 2, mac: 'x' }, '1.2.3.4')).not.toThrow()
  })

  it('rejects a Gen1 device rather than 404ing on every call', () => {
    expect(() => assertGen2({ type: 'SHEM-3', mac: 'x' }, '1.2.3.4')).toThrow(ShellyProtocolError)
  })
})

describe('toSwitchReading', () => {
  it('normalises a metering relay, scaling energy to kWh', () => {
    const r = toSwitchReading(STATUS['switch:0'])
    expect(r.power).toBe(41.2)
    expect(r.voltage).toBe(232.1)
    expect(r.totalForwardEnergy).toBe(12.0456)
    expect(r.valid).toBe(true)
  })

  it('zero-fills a non-metering relay so telemetry keys stay stable', () => {
    const r = toSwitchReading({ id: 0, output: true })
    expect(r).toMatchObject({ power: 0, voltage: 0, current: 0, totalForwardEnergy: 0 })
  })

  it('marks a channel invalid when the device reports an error', () => {
    expect(toSwitchReading({ id: 0, output: false, errors: ['overpower'] }).valid).toBe(false)
  })
})

describe('em readings', () => {
  const em = {
    id: 0,
    a_act_power: 100.5,
    a_voltage: 240,
    a_current: 0.5,
    b_act_power: 50.25,
    b_voltage: 238,
    b_current: 0.25,
    total_act_power: 150.75,
  }
  const data = { id: 0, a_total_act_energy: 1000, b_total_act_energy: 2000, a_total_act_ret_energy: 100 }

  it('rebuilds a phase from the split live/cumulative components', () => {
    // Gen1 returned both together; Gen2 splits them across em and emdata.
    const r = toEmPhaseReading(em, 'a', data)
    expect(r.power).toBe(100.5)
    expect(r.totalForwardEnergy).toBe(1)
    expect(r.totalReturnedEnergy).toBe(0.1)
  })

  it('marks an absent phase invalid', () => {
    expect(toEmPhaseReading(em, 'c', data).valid).toBe(false)
  })

  it('prefers the device aggregate and averages voltage rather than summing it', () => {
    const total = toEmTotalReading(em, data)
    expect(total.power).toBe(150.75)
    expect(total.voltage).toBe(239)
    expect(total.totalForwardEnergy).toBe(3)
  })

  it('falls back to summing when the device reports no aggregate', () => {
    const withoutTotal = { ...em, total_act_power: undefined }
    expect(toEmTotalReading(withoutTotal).power).toBe(150.75)
  })
})
