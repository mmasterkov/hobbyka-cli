#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const VERSION = '0.4.0'
const DEFAULT_BASE_URL = 'https://hobbyka.ru'
const DEFAULT_TIMEOUT_MS = 30_000
const AUTHORIZATION_PROMPT = 'Для того чтобы увидеть партнерские цены и получить доступ к созданию КП необходимо авторизоваться, хотите это сделать?'
const CONTACT_EXPLANATION = 'Сохранить контакт — записать имя, телефон или email и интерес клиента. Эти данные нужны менеджеру для продолжения работы и связи с клиентом, но не открывают автоматическое создание КП.'

class CliError extends Error {
  constructor(code, message, exitCode = 1, details = undefined) {
    super(message)
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

const output = (value, stream = process.stdout) => stream.write(`${JSON.stringify(value)}\n`)

const parseArgs = (argv) => {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const separator = token.indexOf('=')
    if (separator > 2) {
      flags[token.slice(2, separator)] = token.slice(separator + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      index += 1
    } else {
      flags[name] = true
    }
  }
  return { positionals, flags }
}

const scalar = (value, name, { required = false, max = 500 } = {}) => {
  const result = value === undefined || value === null ? '' : String(value).trim()
  if ((required && result === '') || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw new CliError('invalid_argument', `Некорректное значение ${name}.`, 2, { field: name })
  }
  return result
}

const integer = (value, name, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) => {
  if ((value === undefined || value === '') && fallback !== undefined) return fallback
  const result = Number(value)
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new CliError('invalid_argument', `${name} должен быть целым числом от ${min} до ${max}.`, 2, { field: name })
  }
  return result
}

const normalizeBaseUrl = (value) => {
  let url
  try {
    url = new URL(value || DEFAULT_BASE_URL)
  } catch {
    throw new CliError('invalid_base_url', 'Некорректный HOBBYKA_BASE_URL.', 2)
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new CliError('insecure_base_url', 'Для удалённого Hobbyka разрешён только HTTPS.', 2)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const stateFile = () => {
  if (process.env.HOBBYKA_STATE_FILE) return path.resolve(process.env.HOBBYKA_STATE_FILE)
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config')
  return path.join(configRoot, 'hobbyka-cli', 'state.json')
}

const emptyState = () => ({ version: 1, profiles: {} })

const readState = async () => {
  try {
    const value = JSON.parse(await readFile(stateFile(), 'utf8'))
    if (value?.version !== 1 || typeof value.profiles !== 'object' || value.profiles === null) return emptyState()
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw new CliError('state_unavailable', 'Не удалось прочитать защищённое состояние CLI.', 5)
  }
}

const writeState = async (state) => {
  const file = stateFile()
  const directory = path.dirname(file)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  } catch {
    throw new CliError('state_unavailable', 'Не удалось сохранить защищённое состояние CLI.', 5)
  }
}

const profileFor = (state, baseUrl) => state.profiles[baseUrl] || { first_request_completed: false, mode: 'public' }

const contactStatus = (profile) => ({
  registered: Boolean(profile.access_token),
  company_present: Boolean(profile.company_present),
  phone_present: Boolean(profile.phone_present),
  email_present: Boolean(profile.email_present)
})

const authenticatedMode = (profile) => ['partner', 'admin'].includes(profile.mode) && Boolean(profile.access_token)

const accessStatus = (profile) => ({
  mode: authenticatedMode(profile) ? profile.mode : 'public',
  authenticated: authenticatedMode(profile),
  roles: Array.isArray(profile.roles) ? profile.roles : [],
  capabilities: profile.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities : {},
  profile_verified_at: profile.partner_verified_at || null
})

const partnerStatus = (profile) => ({
  connected: authenticatedMode(profile),
  mode: accessStatus(profile).mode,
  profile_verified_at: profile.partner_verified_at || null
})

const requireContact = (profile) => {
  if (profile.first_request_completed && !profile.access_token) {
    throw new CliError(
      'contact_required',
      'Для защищённой операции авторизуйтесь через аккаунт Hobbyka или сохраните контакт.',
      3,
      {
        partner_login: {
          eligibility: 'existing_site_account',
          next_command: 'node scripts/hobbyka-cli.mjs auth login'
        },
        contact_registration: {
          eligibility: 'no_site_account',
          next_command: 'node scripts/hobbyka-cli.mjs contacts set --stdin',
          explanation: CONTACT_EXPLANATION
        }
      }
    )
  }
}

const requireAdmin = (profile) => {
  if (accessStatus(profile).mode !== 'admin') {
    throw new CliError('admin_required', 'Команда доступна менеджерам и администраторам Hobbyka после auth login.', 4)
  }
}

const readStdinJson = async (code = 'invalid_json', message = 'Ожидается JSON-объект в стандартном вводе.') => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(raw)
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('object required')
    return value
  } catch {
    throw new CliError(code, message, 2)
  }
}

const recommendation = (flags) => {
  const profile = scalar(flags['recommendation-profile'], 'recommendation-profile', { max: 128 })
  return profile
    ? { profile, applied: false, note: 'Параметр зарезервирован и не меняет явные требования пользователя в версии 0.1.' }
    : undefined
}

const request = async (baseUrl, route, { method = 'GET', body, token, idempotencyKey } = {}) => {
  const controller = new AbortController()
  const timeoutMs = integer(process.env.HOBBYKA_TIMEOUT_MS, 'HOBBYKA_TIMEOUT_MS', { min: 1000, max: 120000, fallback: DEFAULT_TIMEOUT_MS })
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { Accept: 'application/json', 'User-Agent': `hobbyka-cli/${VERSION}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    let payload = null
    try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
    if (!response.ok) {
      const serverError = payload?.error || payload
      throw new CliError(
        scalar(serverError?.code, 'server_error_code', { max: 128 }) || 'hobbyka_request_failed',
        scalar(serverError?.message, 'server_error_message', { max: 1000 }) || `Hobbyka вернул HTTP ${response.status}.`,
        response.status === 401 || response.status === 403 ? 4 : 5,
        { http_status: response.status, request_id: response.headers.get('x-request-id') || undefined }
      )
    }
    return payload
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error?.name === 'AbortError') throw new CliError('request_timeout', 'Hobbyka не ответил за отведённое время.', 5)
    throw new CliError('network_error', 'Не удалось подключиться к Hobbyka.', 5)
  } finally {
    clearTimeout(timeout)
  }
}

const authorizationGate = () => ({
  status: 'required',
  message: AUTHORIZATION_PROMPT,
  partner_login: {
    eligibility: 'existing_site_account',
    next_command: 'node scripts/hobbyka-cli.mjs auth login'
  },
  contact_registration: {
    eligibility: 'no_site_account',
    next_command: 'node scripts/hobbyka-cli.mjs contacts set --stdin',
    explanation: CONTACT_EXPLANATION
  }
})

const completeFirstRequest = async (state, baseUrl, profile, result, repeatRequest, hasResult = true) => {
  if (!hasResult && !profile.access_token) return result
  if (!profile.first_request_completed && !profile.access_token) {
    const updated = { ...profile, mode: 'public', first_request_completed: true, pending_repeat: repeatRequest, updated_at: new Date().toISOString() }
    state.profiles[baseUrl] = updated
    await writeState(state)
    return { ...result, contact_gate: authorizationGate() }
  }
  if (!profile.access_token) {
    const updated = { ...profile, pending_repeat: repeatRequest, updated_at: new Date().toISOString() }
    state.profiles[baseUrl] = updated
    await writeState(state)
    return { ...result, contact_gate: authorizationGate() }
  }
  return { ...result, access: accessStatus(profile), contact_gate: { status: authenticatedMode(profile) ? profile.mode : 'registered' } }
}

const serverProfile = (payload) => payload?.data || payload

const normalizedServerMode = (profile) => profile?.mode === 'admin' ? 'admin' : 'partner'

const replayPendingRequest = async (baseUrl, profile) => {
  const pending = profile.pending_repeat
  if (!pending || !['search', 'product'].includes(pending.command) || typeof pending.route !== 'string' || !pending.route.startsWith('/api/ai/v1/catalog/')) return null
  const data = await request(baseUrl, pending.route, { token: profile.access_token })
  return { command: pending.command, data }
}

const buildQuery = (entries) => {
  const query = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== '') query.set(key, String(value))
  return query.toString()
}

const parseItems = (value) => {
  const input = scalar(value, 'items', { required: true, max: 4000 })
  const items = input.split(',').map((entry, index) => {
    const match = entry.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
    if (!match || Number(match[1]) < 1 || Number(match[2]) <= 0) {
      throw new CliError('invalid_items', 'items должен иметь формат product_id:quantity через запятую.', 2, { index })
    }
    return { product_id: Number(match[1]), quantity: Number(match[2]) }
  })
  if (items.length < 1 || items.length > 100) throw new CliError('invalid_items', 'Нужно указать от 1 до 100 позиций.', 2)
  return items
}

const publicIdentifier = (value, name) => {
  const result = scalar(value, name, { required: true, max: 64 })
  if (!/^[a-f0-9]{32,64}$/.test(result)) throw new CliError('invalid_public_id', `Некорректный ${name}.`, 2)
  return result
}

const help = () => ({
  ok: true,
  version: VERSION,
  commands: [
    'search --query <text> [--limit 10] [--section-code <code>] [--recommendation-profile <id>]',
    'product --id <id> [--recommendation-profile <id>]',
    'contacts set --stdin',
    'contacts status',
    'contacts clear',
    'auth login',
    'auth complete',
    'auth status',
    'auth logout',
    'partner <login|complete|status|logout> (совместимый псевдоним auth)',
    'offer create --items <product_id:quantity,...>',
    'offer status --public-id <id>',
    'offer list',
    'offer revise --public-id <id> --expected-version <n> --items <product_id:quantity,...>',
    'offer archive --public-id <id> --expected-version <n>',
    'order create (--items <product_id:quantity,...> | --offer-public-id <id>)',
    'order list',
    'order get --public-id <id>',
    'order update --public-id <id> --expected-version <n> [--comments <text>]',
    'order cancel --public-id <id> --expected-version <n> [--reason <text>]',
    'admin offers list [--number <number>] [--manager-id <id>] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD] [--active Y|N] [--page 1] [--limit 50]',
    'admin offers get --id <id>',
    'admin orders list [--id <id>] [--user-id <id>] [--status <code>] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD] [--page 1] [--limit 50]',
    'admin orders get --id <id>',
    'config'
  ]
})

const main = async () => {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const command = positionals[0] || 'help'
  const action = positionals[1]
  if (flags.help || command === 'help') return help()
  if (flags.version || command === 'version') return { ok: true, version: VERSION }

  const baseUrl = normalizeBaseUrl(flags['base-url'] || process.env.HOBBYKA_BASE_URL)
  const state = await readState()
  const profile = profileFor(state, baseUrl)

  if (command === 'config') {
    return {
      ok: true,
      command,
      base_url: baseUrl,
      state_file: stateFile(),
      contact: contactStatus(profile),
      access: accessStatus(profile),
      partner: partnerStatus(profile)
    }
  }

  const authCommand = command === 'auth' || command === 'partner'

  if (authCommand && action === 'login') {
    if (authenticatedMode(profile)) {
      const verified = await request(baseUrl, '/api/partner/v1/profile/', { token: profile.access_token })
      const verifiedProfile = serverProfile(verified)
      return {
        ok: true, command: `${command} login`,
        status: 'already_authorized',
        access: { ...accessStatus(profile), mode: normalizedServerMode(verifiedProfile) },
        profile: verifiedProfile
      }
    }
    const authorization = await request(baseUrl, '/api/partner/v1/auth/device/', {
      method: 'POST', body: { client_name: 'Hobbyka CLI' }
    })
    const data = authorization?.data || authorization
    const deviceCode = scalar(data?.device_code, 'device_code', { required: true, max: 128 })
    state.profiles[baseUrl] = {
      ...profile,
      mode: 'public',
      pending_device_code: deviceCode,
      pending_user_code: scalar(data?.user_code, 'user_code', { required: true, max: 16 }),
      pending_expires_at: new Date(Date.now() + integer(data?.expires_in, 'expires_in', { min: 60, max: 3600 }) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }
    await writeState(state)
    return {
      ok: true, command: `${command} login`, status: 'site_authorization_required',
      user_code: state.profiles[baseUrl].pending_user_code,
      verification_uri: data?.verification_uri,
      verification_uri_complete: data?.verification_uri_complete,
      expires_at: state.profiles[baseUrl].pending_expires_at,
      next_command: 'node scripts/hobbyka-cli.mjs auth complete'
    }
  }

  if (authCommand && action === 'complete') {
    const deviceCode = scalar(profile.pending_device_code, 'pending_device_code', { required: true, max: 128 })
    const authorization = await request(baseUrl, '/api/partner/v1/auth/token/', { method: 'POST', body: { device_code: deviceCode } })
    const data = authorization?.data || authorization
    if (data?.status === 'authorization_pending') {
      return { ok: true, command: `${command} complete`, status: 'authorization_pending', user_code: profile.pending_user_code, verification_uri_complete: `${baseUrl}/personal/partner-cli/?code=${encodeURIComponent(profile.pending_user_code)}` }
    }
    const token = scalar(data?.access_token, 'access_token', { required: true, max: 512 })
    state.profiles[baseUrl] = {
      ...profile, first_request_completed: true, mode: data?.mode === 'admin' ? 'admin' : 'partner', access_token: token,
      expires_at: data?.expires_at || null, partner_verified_at: null, updated_at: new Date().toISOString()
    }
    await writeState(state)
    const verified = await request(baseUrl, '/api/partner/v1/profile/', { token })
    const verifiedProfile = serverProfile(verified)
    state.profiles[baseUrl].mode = normalizedServerMode(verifiedProfile)
    state.profiles[baseUrl].roles = Array.isArray(verifiedProfile?.roles) ? verifiedProfile.roles : []
    state.profiles[baseUrl].scopes = Array.isArray(verifiedProfile?.scopes) ? verifiedProfile.scopes : []
    state.profiles[baseUrl].capabilities = verifiedProfile?.capabilities && typeof verifiedProfile.capabilities === 'object' ? verifiedProfile.capabilities : {}
    state.profiles[baseUrl].partner_verified_at = new Date().toISOString()
    state.profiles[baseUrl].updated_at = new Date().toISOString()
    const replayedRequest = await replayPendingRequest(baseUrl, state.profiles[baseUrl])
    delete state.profiles[baseUrl].pending_device_code
    delete state.profiles[baseUrl].pending_user_code
    delete state.profiles[baseUrl].pending_expires_at
    delete state.profiles[baseUrl].pending_repeat
    await writeState(state)
    return { ok: true, command: `${command} complete`, status: 'authorized', access: accessStatus(state.profiles[baseUrl]), profile: verifiedProfile, replayed_request: replayedRequest }
  }

  if (authCommand && action === 'status') {
    if (!authenticatedMode(profile)) return { ok: true, command: `${command} status`, access: accessStatus(profile) }
    const verified = await request(baseUrl, '/api/partner/v1/profile/', { token: profile.access_token })
    const verifiedProfile = serverProfile(verified)
    return { ok: true, command: `${command} status`, access: { ...accessStatus(profile), mode: normalizedServerMode(verifiedProfile) }, profile: verifiedProfile }
  }

  if (authCommand && action === 'logout') {
    if (authenticatedMode(profile)) await request(baseUrl, '/api/partner/v1/auth/logout/', { method: 'POST', body: {}, token: profile.access_token })
    state.profiles[baseUrl] = { first_request_completed: false, mode: 'public', updated_at: new Date().toISOString() }
    await writeState(state)
    return { ok: true, command: `${command} logout`, access: accessStatus(state.profiles[baseUrl]), partner: partnerStatus(state.profiles[baseUrl]) }
  }

  if (command === 'contacts' && action === 'status') {
    return { ok: true, command: 'contacts status', contact: contactStatus(profile), first_request_completed: Boolean(profile.first_request_completed) }
  }

  if (command === 'contacts' && action === 'clear') {
    state.profiles[baseUrl] = { first_request_completed: Boolean(profile.first_request_completed), updated_at: new Date().toISOString() }
    await writeState(state)
    return { ok: true, command: 'contacts clear', contact: contactStatus(state.profiles[baseUrl]) }
  }

  if (command === 'contacts' && action === 'set') {
    if (!flags.stdin) throw new CliError('stdin_required', 'Передайте контакт как JSON через стандартный ввод и флаг --stdin.', 2)
    const contact = await readStdinJson('invalid_contact_json', 'Ожидается JSON-объект контакта в стандартном вводе.')
    const company = scalar(contact.company, 'company', { required: true, max: 255 })
    const name = scalar(contact.name, 'name', { max: 255 })
    const phone = scalar(contact.phone, 'phone', { max: 64 })
    const email = scalar(contact.email, 'email', { max: 254 })
    if (!phone && !email) throw new CliError('contact_required', 'Укажите телефон либо email.', 2)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError('invalid_email', 'Некорректный email.', 2)
    const registered = await request(baseUrl, '/api/ai/v1/cli/contacts/', {
      method: 'POST',
      body: { company, name: name || undefined, phone: phone || undefined, email: email || undefined, agent: 'hobbyka-cli' }
    })
    const accessToken = scalar(registered?.data?.access_token ?? registered?.access_token, 'access_token', { required: true, max: 512 })
    state.profiles[baseUrl] = {
      first_request_completed: true,
      mode: 'public',
      access_token: accessToken,
      expires_at: registered?.data?.expires_at ?? registered?.expires_at ?? null,
      company_present: true,
      phone_present: Boolean(phone),
      email_present: Boolean(email),
      updated_at: new Date().toISOString()
    }
    await writeState(state)
    return { ok: true, command: 'contacts set', contact: contactStatus(state.profiles[baseUrl]), expires_at: state.profiles[baseUrl].expires_at }
  }

  if (command === 'search') {
    const query = scalar(flags.query ?? flags.q, 'query', { max: 500 })
    const limit = integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 10 })
    const sectionId = flags['section-id'] === undefined ? undefined : integer(flags['section-id'], 'section-id')
    const route = `/api/ai/v1/catalog/products/?${buildQuery([
      ['q', query], ['section_id', sectionId], ['section_code', scalar(flags['section-code'], 'section-code', { max: 128 })],
      ['limit', limit], ['cursor', scalar(flags.cursor, 'cursor', { max: 2048 })], ['agent', 'hobbyka-cli']
    ])}`
    const data = await request(baseUrl, route, { token: profile.access_token })
    const items = data?.data?.items ?? data?.items
    const hasResult = !Array.isArray(items) || items.length > 0
    return completeFirstRequest(state, baseUrl, profile, { ok: true, command, data, recommendation: recommendation(flags) }, { command, route }, hasResult)
  }

  if (command === 'product') {
    const id = integer(flags.id, 'id')
    const route = `/api/ai/v1/catalog/products/${id}/?agent=hobbyka-cli`
    const data = await request(baseUrl, route, { token: profile.access_token })
    return completeFirstRequest(state, baseUrl, profile, { ok: true, command, data, recommendation: recommendation(flags) }, { command, route })
  }

  if (command === 'offer' && action === 'create') {
    if (!authenticatedMode(profile)) {
      throw new CliError('authorization_required', 'Создание КП доступно только после входа через сайт командой auth login.', 3)
    }
    const body = { items: parseItems(flags.items), agent: 'hobbyka-cli' }
    const object = {
      name: scalar(flags['object-name'], 'object-name', { max: 500 }),
      city: scalar(flags.city, 'city', { max: 255 }),
      address: scalar(flags.address, 'address', { max: 500 }),
      comments: scalar(flags.comments, 'comments', { max: 1000 })
    }
    const objectValues = Object.fromEntries(Object.entries(object).filter(([, value]) => value !== ''))
    if (Object.keys(objectValues).length) body.object = objectValues
    const data = await request(baseUrl, '/api/partner/v1/commercial-offers/', {
      method: 'POST',
      body,
      token: profile.access_token,
      idempotencyKey: scalar(flags['idempotency-key'], 'idempotency-key', { max: 128 }) || randomUUID()
    })
    return { ok: true, command: 'offer create', data, recommendation: recommendation(flags), contact_gate: { status: profile.mode } }
  }

  if (command === 'offer' && action === 'status') {
    requireContact(profile)
    const publicId = scalar(flags['public-id'], 'public-id', { required: true, max: 64 })
    if (!/^[a-f0-9]{32,64}$/.test(publicId)) throw new CliError('invalid_public_id', 'Некорректный public-id КП.', 2)
    const data = await request(baseUrl, `/api/ai/v1/commercial-offers/${publicId}/?agent=hobbyka-cli`, { token: profile.access_token })
    return { ok: true, command: 'offer status', data, contact_gate: { status: 'registered' } }
  }

  if (command === 'offer' && action === 'list') {
    if (!authenticatedMode(profile)) throw new CliError('authorization_required', 'Войдите через сайт командой auth login.', 3)
    const limit = integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })
    const data = await request(baseUrl, `/api/partner/v1/commercial-offers/?limit=${limit}`, { token: profile.access_token })
    return { ok: true, command: 'offer list', data }
  }

  if (command === 'offer' && action === 'revise') {
    if (!authenticatedMode(profile)) throw new CliError('authorization_required', 'Войдите через сайт командой auth login.', 3)
    const publicId = publicIdentifier(flags['public-id'], 'public-id')
    const body = { expected_version: integer(flags['expected-version'], 'expected-version'), items: parseItems(flags.items), agent: 'hobbyka-cli' }
    const data = await request(baseUrl, `/api/partner/v1/commercial-offers/${publicId}/`, {
      method: 'PATCH', body, token: profile.access_token,
      idempotencyKey: scalar(flags['idempotency-key'], 'idempotency-key', { max: 128 }) || randomUUID()
    })
    return { ok: true, command: 'offer revise', data }
  }

  if (command === 'offer' && action === 'archive') {
    if (!authenticatedMode(profile)) throw new CliError('authorization_required', 'Войдите через сайт командой auth login.', 3)
    const publicId = publicIdentifier(flags['public-id'], 'public-id')
    const data = await request(baseUrl, `/api/partner/v1/commercial-offers/${publicId}/archive/`, {
      method: 'POST', body: { expected_version: integer(flags['expected-version'], 'expected-version') }, token: profile.access_token
    })
    return { ok: true, command: 'offer archive', data }
  }

  if (command === 'order') {
    if (!authenticatedMode(profile)) throw new CliError('authorization_required', 'Войдите через сайт командой auth login.', 3)
    if (action === 'list') {
      const limit = integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })
      const data = await request(baseUrl, `/api/partner/v1/orders/?limit=${limit}`, { token: profile.access_token })
      return { ok: true, command: 'order list', data }
    }
    if (action === 'get') {
      const publicId = publicIdentifier(flags['public-id'], 'public-id')
      const data = await request(baseUrl, `/api/partner/v1/orders/${publicId}/`, { token: profile.access_token })
      return { ok: true, command: 'order get', data }
    }
    if (action === 'create') {
      const body = { comments: scalar(flags.comments, 'comments', { max: 1000 }) || undefined }
      if (flags.items) body.items = parseItems(flags.items)
      if (flags['offer-public-id']) body.offer_public_id = publicIdentifier(flags['offer-public-id'], 'offer-public-id')
      if (!body.items && !body.offer_public_id) throw new CliError('invalid_argument', 'Укажите --items либо --offer-public-id.', 2)
      const data = await request(baseUrl, '/api/partner/v1/orders/', {
        method: 'POST', body, token: profile.access_token,
        idempotencyKey: scalar(flags['idempotency-key'], 'idempotency-key', { max: 128 }) || randomUUID()
      })
      return { ok: true, command: 'order create', data }
    }
    if (action === 'update') {
      const publicId = publicIdentifier(flags['public-id'], 'public-id')
      const body = { expected_version: integer(flags['expected-version'], 'expected-version'), comments: scalar(flags.comments, 'comments', { max: 1000 }) }
      const data = await request(baseUrl, `/api/partner/v1/orders/${publicId}/`, { method: 'PATCH', body, token: profile.access_token })
      return { ok: true, command: 'order update', data }
    }
    if (action === 'cancel') {
      const publicId = publicIdentifier(flags['public-id'], 'public-id')
      const body = { expected_version: integer(flags['expected-version'], 'expected-version'), reason: scalar(flags.reason, 'reason', { max: 500 }) }
      const data = await request(baseUrl, `/api/partner/v1/orders/${publicId}/cancel/`, { method: 'POST', body, token: profile.access_token })
      return { ok: true, command: 'order cancel', data }
    }
  }

  if (command === 'admin') {
    requireAdmin(profile)
    const resource = action
    const operation = positionals[2]
    if (resource === 'offers' && operation === 'list') {
      const route = `/api/internal/v1/commercial-offers/?${buildQuery([
        ['number', scalar(flags.number, 'number', { max: 64 })],
        ['manager_id', flags['manager-id'] === undefined ? undefined : integer(flags['manager-id'], 'manager-id')],
        ['date_from', scalar(flags['date-from'], 'date-from', { max: 10 })],
        ['date_to', scalar(flags['date-to'], 'date-to', { max: 10 })],
        ['active', scalar(flags.active, 'active', { max: 1 })],
        ['page', integer(flags.page, 'page', { min: 1, max: 1000000, fallback: 1 })],
        ['limit', integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })]
      ])}`
      const data = await request(baseUrl, route, { token: profile.access_token })
      return { ok: true, command: 'admin offers list', access: accessStatus(profile), data }
    }
    if (resource === 'offers' && operation === 'get') {
      const id = integer(flags.id, 'id')
      const data = await request(baseUrl, `/api/internal/v1/commercial-offers/${id}/`, { token: profile.access_token })
      return { ok: true, command: 'admin offers get', access: accessStatus(profile), data }
    }
    if (resource === 'orders' && operation === 'list') {
      const route = `/api/internal/v1/orders/?${buildQuery([
        ['id', flags.id === undefined ? undefined : integer(flags.id, 'id')],
        ['user_id', flags['user-id'] === undefined ? undefined : integer(flags['user-id'], 'user-id')],
        ['status', scalar(flags.status, 'status', { max: 32 })],
        ['date_from', scalar(flags['date-from'], 'date-from', { max: 10 })],
        ['date_to', scalar(flags['date-to'], 'date-to', { max: 10 })],
        ['page', integer(flags.page, 'page', { min: 1, max: 1000000, fallback: 1 })],
        ['limit', integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })]
      ])}`
      const data = await request(baseUrl, route, { token: profile.access_token })
      return { ok: true, command: 'admin orders list', access: accessStatus(profile), data }
    }
    if (resource === 'orders' && operation === 'get') {
      const id = integer(flags.id, 'id')
      const data = await request(baseUrl, `/api/internal/v1/orders/${id}/`, { token: profile.access_token })
      return { ok: true, command: 'admin orders get', access: accessStatus(profile), data }
    }
  }

  throw new CliError('unknown_command', 'Неизвестная команда Hobbyka CLI.', 2, { command, action })
}

try {
  output(await main())
} catch (error) {
  const safe = error instanceof CliError ? error : new CliError('internal_error', 'Внутренняя ошибка Hobbyka CLI.', 1)
  output({ ok: false, error: { code: safe.code, message: safe.message, details: safe.details } }, process.stderr)
  process.exitCode = safe.exitCode
}
