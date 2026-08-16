import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_DSH_HOME = '/var/lib/dsh/.dsh'
export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-v4-flash'
export const DEFAULT_DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY'

function sectionPattern(section) {
  return new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`)
}

function isSectionHeading(line) {
  return /^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*$/.test(line)
}

function scalar(value) {
  return JSON.stringify(String(value))
}

function splitDocument(text) {
  const finalNewline = text.endsWith('\n')
  const lines = text.split(/\r?\n/)
  if (finalNewline) lines.pop()
  return { lines, finalNewline }
}

function renderDocument(lines, finalNewline = true) {
  return `${lines.join('\n')}${finalNewline || lines.length > 0 ? '\n' : ''}`
}

function sectionBounds(lines, section) {
  const start = lines.findIndex(line => sectionPattern(section).test(line))
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length && !isSectionHeading(lines[end])) end += 1
  return { start, end }
}

export function readSection(text, section, fields) {
  const { lines } = splitDocument(text)
  const bounds = sectionBounds(lines, section)
  const result = {}
  if (!bounds) return result
  for (const field of fields) {
    const pattern = new RegExp(`^  ${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`)
    const line = lines.slice(bounds.start + 1, bounds.end).find(value => pattern.test(value))
    if (line !== undefined) {
      const match = line.match(pattern)
      result[field] = match?.[1]?.replace(/^(['"])(.*)\1$/, '$2') ?? ''
    }
  }
  return result
}

export function updateSection(text, section, values) {
  const { lines, finalNewline } = splitDocument(text)
  const bounds = sectionBounds(lines, section)
  if (!bounds) {
    if (lines.length > 0 && lines.at(-1) !== '') lines.push('')
    lines.push(`${section}:`)
    for (const [key, value] of Object.entries(values)) lines.push(`  ${key}: ${scalar(value)}`)
    return renderDocument(lines, true)
  }
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^  ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
    const index = lines.findIndex((line, offset) => offset > bounds.start && offset < bounds.end && pattern.test(line))
    if (index >= 0) lines[index] = `  ${key}: ${scalar(value)}`
    else lines.splice(bounds.end, 0, `  ${key}: ${scalar(value)}`)
  }
  return renderDocument(lines, finalNewline)
}

export function removeSection(text, section) {
  const { lines, finalNewline } = splitDocument(text)
  const bounds = sectionBounds(lines, section)
  if (!bounds) return text
  const removeStart = bounds.start > 0 && lines[bounds.start - 1] === '' ? bounds.start - 1 : bounds.start
  lines.splice(removeStart, bounds.end - removeStart)
  if (lines[removeStart] === '') lines.splice(removeStart, 1)
  return renderDocument(lines, finalNewline)
}

export function removeSectionField(text, section, field) {
  const { lines, finalNewline } = splitDocument(text)
  const bounds = sectionBounds(lines, section)
  if (!bounds) return text
  const pattern = new RegExp(`^  ${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const index = lines.findIndex((line, offset) => offset > bounds.start && offset < bounds.end && pattern.test(line))
  if (index >= 0) lines.splice(index, 1)
  return renderDocument(lines, finalNewline)
}

export function updateCredential(text, ref, value) {
  const { lines, finalNewline } = splitDocument(text)
  const pattern = new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const index = lines.findIndex(line => pattern.test(line))
  const line = `${ref}: ${scalar(value)}`
  if (index >= 0) lines[index] = line
  else lines.push(line)
  return renderDocument(lines, finalNewline)
}

export function removeCredential(text, ref) {
  const { lines, finalNewline } = splitDocument(text)
  const pattern = new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const index = lines.findIndex(line => pattern.test(line))
  if (index >= 0) lines.splice(index, 1)
  return renderDocument(lines, finalNewline)
}

export function configuredCredentialRefs(text) {
  return text.split(/\r?\n/)
    .map(line => line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/)?.[1])
    .filter(Boolean)
}

async function withFileLock(filename, action) {
  const lock = `${filename}.lock`
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === 119) throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  try {
    return await action()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

export async function readConfigFile(filename) {
  try {
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

export async function updateConfigFile(filename, transform) {
  return withFileLock(filename, async () => {
    const current = await readConfigFile(filename)
    const next = transform(current)
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, next, { mode: 0o600 })
    await rename(temporary, filename)
    return next
  })
}

export function settingsPath(dshHome = process.env.DSH_HOME || DEFAULT_DSH_HOME) {
  return join(dshHome, 'settings.yaml')
}

export function credentialsPath(dshHome = process.env.DSH_HOME || DEFAULT_DSH_HOME) {
  return join(dshHome, '.credentials.yaml')
}

export function validateIdentifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) throw new Error(`${label} 格式无效：${value}`)
  return value
}

export function validateModel(value) {
  if (!value || /\s/.test(value)) throw new Error(`模型 ID 无效：${value}`)
  return value
}
