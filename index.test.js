'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { parseRoutes, serverURL, decide, writeOutputs } = require('./index.js')

// stub serves the OIDC token endpoint and /runner/pick, answering pick with
// each successive entry of answers (the last repeats).
async function stub(answers) {
  const seen = { picks: [], audiences: [] }
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/token')) {
      seen.audiences.push(new URL(req.url, 'http://x').searchParams.get('audience'))
      res.end(JSON.stringify({ value: 'oidc-token' }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.picks.push({ auth: req.headers.authorization, body: JSON.parse(body) })
      const a = answers[Math.min(seen.picks.length - 1, answers.length - 1)]
      if (typeof a === 'number') {
        res.statusCode = a
        res.end()
        return
      }
      res.end(JSON.stringify(a))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${srv.address().port}`
  return {
    seen,
    env: (extra = {}) => ({
      INPUT_SERVER: origin,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token',
      ...extra,
    }),
    close: () => new Promise((r) => srv.close(r)),
  }
}

// A fake clock: waiting advances it instead of sleeping.
function clock() {
  let t = 1_000_000
  return { now: () => t, wait: async (ms) => void (t += ms) }
}

const one = parseRoutes({ INPUT_WANT: 'badgery-macos', INPUT_FALLBACK: 'macos-15' })
const verdict = (answer, reason = '', graceSeconds = 180) => ({ labels: { runner: { answer, reason } }, graceSeconds })

test('routes: want/fallback or a routes block, never both, labels checked', () => {
  assert.deepEqual(one, [{ key: 'runner', want: 'badgery-macos', fallback: 'macos-15' }])
  assert.deepEqual(parseRoutes({ INPUT_ROUTES: 'linux: badgery-linux -> ubuntu-latest\n# c\n\nmac: badgery-macos -> macos-15' }), [
    { key: 'linux', want: 'badgery-linux', fallback: 'ubuntu-latest' },
    { key: 'mac', want: 'badgery-macos', fallback: 'macos-15' },
  ])
  assert.throws(() => parseRoutes({ INPUT_ROUTES: 'a: x -> y', INPUT_WANT: 'x' }))
  assert.throws(() => parseRoutes({ INPUT_WANT: 'badgery-linux' }), /fallback/)
  assert.throws(() => parseRoutes({ INPUT_WANT: 'a b', INPUT_FALLBACK: 'c' }))
  assert.throws(() => parseRoutes({ INPUT_ROUTES: 'a: x -> y\na: x -> z' }), /repeated/)
})

test('server: https origin only, http just for loopback', () => {
  assert.equal(serverURL('https://hooks.badgery.ai').origin, 'https://hooks.badgery.ai')
  assert.ok(serverURL('http://127.0.0.1:8080'))
  assert.throws(() => serverURL('http://hooks.badgery.ai'))
  assert.throws(() => serverURL('https://hooks.badgery.ai/x'))
  assert.throws(() => serverURL('https://u:p@hooks.badgery.ai'))
})

test('healthy Badgery: want, asked once, token for the server origin', async () => {
  const s = await stub([verdict('want')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'badgery-macos')
    assert.equal(s.seen.picks.length, 1)
    assert.equal(s.seen.picks[0].auth, 'Bearer oidc-token')
    assert.deepEqual(s.seen.picks[0].body, { labels: { runner: 'badgery-macos' } })
    assert.deepEqual(s.seen.audiences, [s.env().INPUT_SERVER])
  } finally {
    await s.close()
  }
})

test('label not offered: fallback at once, with the reason', async () => {
  const s = await stub([verdict('fallback', 'no host offers badgery-macos')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'macos-15')
    assert.match(got.runner.reason, /no host offers/)
    assert.equal(s.seen.picks.length, 1)
  } finally {
    await s.close()
  }
})

test('unhealthy then healthy inside the grace period: want', async () => {
  const s = await stub([verdict('unhealthy', 'host restarting'), verdict('unhealthy'), verdict('want')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'badgery-macos')
    assert.equal(s.seen.picks.length, 3)
  } finally {
    await s.close()
  }
})

test('unhealthy past the grace period: fallback, without asking past it', async () => {
  const s = await stub([verdict('unhealthy', 'no host connected', 60)])
  try {
    const c = clock()
    const start = c.now()
    const got = await decide(s.env(), one, c)
    assert.equal(got.runner.label, 'macos-15')
    assert.match(got.runner.reason, /grace period: no host connected/)
    assert.ok(c.now() - start <= 60_000)
    assert.ok(s.seen.picks.length >= 2 && s.seen.picks.length <= 7)
  } finally {
    await s.close()
  }
})

test('grace is capped at 30 minutes whatever the server says', async () => {
  const s = await stub([verdict('unhealthy', 'x', 86_400)])
  try {
    const c = clock()
    const start = c.now()
    await decide(s.env(), one, c)
    assert.ok(c.now() - start <= 30 * 60_000)
  } finally {
    await s.close()
  }
})

test('Badgery errors or unreachable: fallback', async () => {
  for (const answer of [500, 404, { labels: {} }, { labels: { runner: { answer: 'ubuntu-latest' } } }]) {
    const s = await stub([answer])
    try {
      const got = await decide(s.env(), one, clock())
      assert.equal(got.runner.label, 'macos-15', JSON.stringify(answer))
    } finally {
      await s.close()
    }
  }
  // A port nothing listens on.
  const s = await stub([verdict('want')])
  const env = s.env()
  await s.close()
  const got = await decide({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'http://127.0.0.1:9/token' }, one, clock())
  assert.equal(got.runner.label, 'macos-15')
})

test('Badgery stopping mid-grace: one more try, then fallback', async () => {
  const s = await stub([verdict('unhealthy'), 503, 503, verdict('want')])
  try {
    const got = await decide(s.env(), one, clock())
    assert.equal(got.runner.label, 'macos-15')
    assert.match(got.runner.reason, /unreachable/)
    assert.equal(s.seen.picks.length, 3)
  } finally {
    await s.close()
  }
})

test('no id-token permission: fallback naming the fix', async () => {
  const got = await decide({ INPUT_SERVER: 'https://hooks.badgery.ai' }, one, clock())
  assert.equal(got.runner.label, 'macos-15')
  assert.match(got.runner.reason, /id-token: write/)
})

test('black-holed Badgery costs the connect timeout, not the request timeout', async () => {
  const env = {
    INPUT_SERVER: 'https://10.255.255.1',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'x',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x',
  }
  const s = await stub([verdict('want')])
  try {
    // The token comes from the stub; the pick goes to the black hole.
    env.ACTIONS_ID_TOKEN_REQUEST_URL = s.env().ACTIONS_ID_TOKEN_REQUEST_URL
    const start = Date.now()
    const got = await decide(env, one, clock())
    const took = Date.now() - start
    assert.equal(got.runner.label, 'macos-15')
    assert.ok(took < 4_000, `took ${took} ms`)
  } finally {
    await s.close()
  }
})

test('outputs are only ever the workflow’s own labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'))
  const env = { GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum') }
  const routes = parseRoutes({ INPUT_ROUTES: 'a: badgery-linux -> ubuntu-latest\nb: badgery-macos -> macos-15' })
  const write = process.stdout.write
  process.stdout.write = () => true
  try {
    writeOutputs(env, routes, { a: { label: 'badgery-linux', reason: 'ok' }, b: { label: 'evil-label', reason: 'x|y' } })
  } finally {
    process.stdout.write = write
  }
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'a=badgery-linux\nb=macos-15\n')
  fs.rmSync(dir, { recursive: true })
})
