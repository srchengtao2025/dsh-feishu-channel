#!/usr/bin/env node

import { stdin, stdout } from 'node:process'
import { MODEL_HELP_TEXT, parseModelCliArgs } from './model-cli-core.js'
import {
  DEFAULT_DEEPSEEK_KEY_REF,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  configuredCredentialRefs,
  credentialsPath,
  readConfigFile,
  readSection,
  removeCredential,
  removeSection,
  removeSectionField,
  settingsPath,
  updateConfigFile,
  updateCredential,
  updateSection,
  validateIdentifier,
  validateModel,
} from './model-config.js'

async function readStdin() {
  const chunks = []
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const value = Buffer.concat(chunks).toString('utf8').trim()
  if (!value) throw new Error('stdin 中没有读取到 API Key')
  return value
}

function home(values) {
  return values['dsh-home'] || process.env.DSH_HOME || '/var/lib/dsh/.dsh'
}

async function show(values) {
  const settings = await readConfigFile(settingsPath(home(values)))
  const credentials = await readConfigFile(credentialsPath(home(values)))
  const current = readSection(settings, 'agent-default-model', ['provider', 'model', 'reasoningEffort'])
  stdout.write(`默认 Provider: ${current.provider || DEFAULT_PROVIDER}\n`)
  stdout.write(`默认模型: ${current.model || DEFAULT_MODEL}\n`)
  if (current.reasoningEffort) stdout.write(`推理档位: ${current.reasoningEffort}\n`)
  stdout.write(`已配置凭据引用: ${configuredCredentialRefs(credentials).join(', ') || '无'}\n`)
}

async function setDefault(values, { forceDeepSeek = false } = {}) {
  const provider = validateIdentifier(values.provider || (forceDeepSeek ? DEFAULT_PROVIDER : ''), 'Provider')
  const model = validateModel(values.model || (forceDeepSeek ? DEFAULT_MODEL : ''))
  const filename = settingsPath(home(values))
  const updates = { provider, model }
  if (values['clear-reasoning-effort']) {
    await updateConfigFile(filename, text => removeSectionField(updateSection(text, 'agent-default-model', updates), 'agent-default-model', 'reasoningEffort'))
  } else if (values['reasoning-effort'] !== undefined) {
    updates.reasoningEffort = values['reasoning-effort']
    await updateConfigFile(filename, text => updateSection(text, 'agent-default-model', updates))
  } else {
    await updateConfigFile(filename, text => updateSection(text, 'agent-default-model', updates))
  }
  stdout.write(`默认模型已设置为 ${provider}/${model}\n`)
}

async function setCredential(values, remove = false) {
  const ref = validateIdentifier(values.ref || DEFAULT_DEEPSEEK_KEY_REF, '凭据引用')
  const filename = credentialsPath(home(values))
  if (remove) {
    await updateConfigFile(filename, text => removeCredential(text, ref))
    stdout.write(`凭据引用已删除：${ref}\n`)
    return
  }
  if (!values['api-key-stdin']) throw new Error('写入凭据必须使用 --api-key-stdin')
  const value = await readStdin()
  await updateConfigFile(filename, text => updateCredential(text, ref, value))
  stdout.write(`凭据已保存：${ref}（不回显）\n`)
}

async function main() {
  const parsed = parseModelCliArgs(process.argv.slice(2))
  if (parsed.values.help || parsed.command === 'help') {
    stdout.write(MODEL_HELP_TEXT)
    return
  }
  if (parsed.command === 'show') return show(parsed.values)
  if (parsed.command === 'set-default') return setDefault(parsed.values)
  if (parsed.command === 'reset-default') {
    await updateConfigFile(settingsPath(home(parsed.values)), text => removeSection(text, 'agent-default-model'))
    stdout.write('已移除用户默认模型配置，将使用 profile 内置默认值。\n')
    return
  }
  if (parsed.command === 'set-deepseek') {
    await setDefault(parsed.values, { forceDeepSeek: true })
    if (parsed.values['api-key-stdin']) await setCredential({ ...parsed.values, ref: parsed.values.ref || DEFAULT_DEEPSEEK_KEY_REF })
    return
  }
  if (parsed.command === 'credential') {
    const action = parsed.positionals[0]
    if (action === 'set') return setCredential(parsed.values)
    if (action === 'unset') return setCredential(parsed.values, true)
  }
  throw new Error(`未知命令：${parsed.command}\n\n${MODEL_HELP_TEXT}`)
}

main().catch(error => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
