import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { ShellyGen1Client, ShellyProtocolError } from '../src/protocol/ShellyGen1Client'

/**
 * A stand-in Shelly served over real HTTP, so the client is exercised through
 * the same socket path it uses in production rather than a mocked module.
 */
let server: http.Server
let host: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? ''

    if (url === '/shelly') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'SHEM-3', mac: 'C8C9A33E65D6', num_emeters: 3, fw: 'v1.14.0' }))
      return
    }
    if (url === '/emeter/0') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          power: 8.19,
          pf: 0.45,
          current: 0.14,
          voltage: 247.86,
          is_valid: true,
          total: 1,
          total_returned: 0,
        }),
      )
      return
    }
    if (url === '/auth-required') {
      res.writeHead(401)
      res.end('Unauthorized')
      return
    }
    if (url === '/garbage') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>not json</html>')
      return
    }
    if (url === '/slow') {
      // Never responds — exercises the timeout path.
      return
    }

    // Everything else behaves like a real Gen1 device asked for an RPC path.
    res.writeHead(404)
    res.end('Not Found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('ShellyGen1Client', () => {
  it('parses /shelly', async () => {
    const info = await new ShellyGen1Client(host).getDeviceInfo()
    expect(info.type).toBe('SHEM-3')
    expect(info.num_emeters).toBe(3)
  })

  it('parses a single channel', async () => {
    const emeter = await new ShellyGen1Client(host).getEmeter(0)
    expect(emeter.power).toBe(8.19)
    expect(emeter.voltage).toBe(247.86)
  })

  it('surfaces 404 with the path and body, not a JSON parse error', async () => {
    // A Gen1 device answers "Not Found" for /rpc/ paths. The message has to
    // name the path so the cause is obvious from a single log line.
    const client = new ShellyGen1Client(host)
    await expect(client.getStatus()).rejects.toThrow(ShellyProtocolError)
    await expect(client.getStatus()).rejects.toThrow(/HTTP 404 for \/status/)
  })

  it('reports authentication failures as actionable errors', async () => {
    const client = new ShellyGen1Client(host)
    await expect((client as any).request('/auth-required')).rejects.toThrow(/username and password/)
  })

  it('rejects non-JSON bodies', async () => {
    const client = new ShellyGen1Client(host)
    await expect((client as any).request('/garbage')).rejects.toThrow(/Invalid JSON/)
  })

  it('times out rather than hanging forever', async () => {
    const client = new ShellyGen1Client(host, { timeout: 300 })
    await expect((client as any).request('/slow')).rejects.toThrow(/Timed out after 300ms/)
  })

  it('fails cleanly when the host is unreachable', async () => {
    // Port 1 on localhost refuses connections.
    const client = new ShellyGen1Client('127.0.0.1:1', { timeout: 500 })
    await expect(client.getDeviceInfo()).rejects.toThrow()
  })
})
