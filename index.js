// Badgery runner picker. docs/runner-fallback.md is the design.
//
// Asks the Badgery server whether it is healthy and has each wanted label, and
// writes either that label or the customer's fallback as an output. It fails
// open: any error, refusal or silence chooses the fallback, because the case
// this exists for is Badgery being down. Every output is one of the labels the
// workflow itself wrote; the server's answer is a verdict, never a label.
//
// No dependencies, so nothing is installed or bundled per run.
'use strict'

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')

const CONNECT_TIMEOUT_MS = 2_000
// Measured: a staging round trip took 3.5-4.2 s in 2 of 8 calls.
const REQUEST_TIMEOUT_MS = 10_000
const RETRY_MS = 10_000
// The server says how long to ride out an unhealthy Badgery; never longer than
// this, so the job's timeout-minutes backstop (35) stays out of reach.
const MAX_GRACE_MS = 30 * 60_000
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function parseRoutes(env) {
  const input = (name) => (env[`INPUT_${name.toUpperCase()}`] || '').trim()
  const want = input('want')
  const fallback = input('fallback')
  const routes = input('routes')
  const out = []
  if (routes) {
    if (want || fallback) throw new Error('use either routes or want/fallback, not both')
    for (const raw of routes.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = /^([^:\s]+)\s*:\s*(\S+)\s*->\s*(\S+)$/.exec(line)
      if (!m) throw new Error(`route line not "key: want -> fallback": ${line}`)
      out.push({ key: m[1], want: m[2], fallback: m[3] })
    }
  } else {
    out.push({ key: 'runner', want, fallback })
  }
  if (out.length === 0) throw new Error('no routes')
  const seen = new Set()
  for (const r of out) {
    if (!KEY.test(r.key) || seen.has(r.key)) throw new Error(`bad or repeated route key: ${r.key}`)
    seen.add(r.key)
    if (!LABEL.test(r.want)) throw new Error(`bad want label for ${r.key}: ${r.want}`)
    if (!LABEL.test(r.fallback)) throw new Error(`bad fallback label for ${r.key}: ${r.fallback}`)
  }
  return out
}

function serverURL(raw) {
  const u = new URL(raw)
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('server must be https')
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error('server must be an origin, with no path')
  }
  return u
}

// request is one HTTP exchange with a connect timeout separate from the
// overall one: a black-holed Badgery should cost two seconds, a slow one ten.
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(url, { method, headers, agent: false }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > 64 << 10) req.destroy(new Error('response too large'))
        else chunks.push(c)
      })
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    const fail = (why) => req.destroy(new Error(why))
    const connect = setTimeout(() => fail('connect timed out'), CONNECT_TIMEOUT_MS)
    const overall = setTimeout(() => fail('timed out'), REQUEST_TIMEOUT_MS)
    req.on('socket', (s) => {
      const connected = () => clearTimeout(connect)
      if (!s.connecting) connected()
      s.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', connected)
    })
    req.on('error', reject)
    req.on('close', () => {
      clearTimeout(connect)
      clearTimeout(overall)
    })
    req.end(body)
  })
}

async function idToken(env, audience) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !bearer) throw new Error('no OIDC token: the pick job needs `permissions: { id-token: write }`')
  const u = new URL(url)
  u.searchParams.set('audience', audience)
  const res = await request(u, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } })
  if (res.status !== 200) throw new Error(`OIDC token request: HTTP ${res.status}`)
  const value = JSON.parse(res.body).value
  if (typeof value !== 'string' || !value) throw new Error('OIDC token request: no token')
  return value
}

// ask returns the server's verdict per route key: "want", "fallback" or
// "unhealthy", each with a reason, plus how long to ride out "unhealthy".
async function ask(server, token, routes) {
  const body = JSON.stringify({ labels: Object.fromEntries(routes.map((r) => [r.key, r.want])) })
  const res = await request(new URL('/runner/pick', server), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  })
  if (res.status !== 200) throw new Error(`Badgery answered HTTP ${res.status}`)
  const parsed = JSON.parse(res.body)
  const verdicts = {}
  for (const r of routes) {
    const v = parsed.labels && parsed.labels[r.key]
    const answer = v && v.answer
    if (answer !== 'want' && answer !== 'fallback' && answer !== 'unhealthy') throw new Error(`Badgery gave no answer for ${r.key}`)
    verdicts[r.key] = { answer, reason: typeof v.reason === 'string' ? v.reason.slice(0, 200) : '' }
  }
  const grace = Number(parsed.graceSeconds)
  return { verdicts, graceMs: Number.isFinite(grace) && grace > 0 ? Math.min(grace * 1000, MAX_GRACE_MS) : 0 }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// decide never throws once the routes are parsed: every failure is a fallback
// with its reason.
async function decide(env, routes, { now = Date.now, wait = sleep } = {}) {
  const fallbackAll = (reason) => Object.fromEntries(routes.map((r) => [r.key, { label: r.fallback, reason }]))
  let server
  try {
    server = serverURL(env.INPUT_SERVER || 'https://hooks.badgery.ai')
  } catch (e) {
    return fallbackAll(e.message)
  }
  let token
  try {
    token = await idToken(env, server.origin)
  } catch (e) {
    return fallbackAll(e.message)
  }
  const started = now()
  let deadline = null
  let failures = 0
  for (;;) {
    let result
    try {
      result = await ask(server, token, routes)
      failures = 0
    } catch (e) {
      // A Badgery that was answering and then stopped gets one more try.
      failures++
      if (deadline === null || failures > 1 || now() + RETRY_MS >= deadline) {
        return fallbackAll(`Badgery unreachable: ${e.message}`)
      }
      await wait(RETRY_MS)
      continue
    }
    if (deadline === null) deadline = started + result.graceMs
    const pending = routes.filter((r) => result.verdicts[r.key].answer === 'unhealthy')
    if (pending.length === 0 || now() + RETRY_MS >= deadline) {
      return Object.fromEntries(
        routes.map((r) => {
          const v = result.verdicts[r.key]
          if (v.answer === 'want') return [r.key, { label: r.want, reason: 'Badgery is healthy and has it' }]
          const why = v.answer === 'unhealthy' ? `Badgery unhealthy past the grace period: ${v.reason}` : v.reason
          return [r.key, { label: r.fallback, reason: why || 'Badgery declined' }]
        }),
      )
    }
    await wait(RETRY_MS)
  }
}

function writeOutputs(env, routes, chosen) {
  const lines = []
  const summary = ['| Route | Runner | Why |', '|---|---|---|']
  for (const r of routes) {
    const c = chosen[r.key]
    // Belt and braces: an output is only ever one of the workflow's labels.
    const label = c.label === r.want ? r.want : r.fallback
    lines.push(`${r.key}=${label}`)
    summary.push(`| ${r.key} | \`${label}\` | ${c.reason.replace(/[|\n]/g, ' ')} |`)
    const kind = label === r.want ? 'notice' : 'warning'
    process.stdout.write(`::${kind} title=Badgery runner (${r.key})::${label}: ${c.reason.replace(/[\r\n%]/g, ' ')}\n`)
  }
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n')
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n')
}

async function main(env = process.env) {
  let routes
  try {
    routes = parseRoutes(env)
  } catch (e) {
    // A malformed step has no fallback to fall back to: fail the job, loudly.
    process.stdout.write(`::error title=Badgery runner::${e.message}\n`)
    return 1
  }
  writeOutputs(env, routes, await decide(env, routes))
  return 0
}

module.exports = { parseRoutes, serverURL, decide, writeOutputs, main }

if (require.main === module) {
  // Exit as soon as the outputs are written: an abandoned connection must not
  // hold the step open (measured: 11 s idle without this, 3 s with it).
  main().then((code) => process.exit(code), (e) => {
    process.stdout.write(`::error title=Badgery runner::${e && e.message}\n`)
    process.exit(1)
  })
}
