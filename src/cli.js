#!/usr/bin/env node

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { ConfigApiClient, HELP_TEXT, configSavePayload, formatConfig, parseCliArgs } from './cli-core.js'

async function readStdin() {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  return Buffer.concat(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('utf8').trim()
}

async function hiddenQuestion(label) {
  if (!stdin.isTTY || !stdin.setRawMode) return ''
  stdout.write(label)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new Error('已取消'))
        if (char === '\r' || char === '\n') return finish()
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

function yes(value, fallback) {
  const text = String(value).trim().toLowerCase()
  if (!text) return fallback
  return ['y', 'yes', '是', 'true', '1'].includes(text)
}

async function interactiveConfigure(client) {
  const payload = await client.getConfig()
  const current = payload.config
  stdout.write(`${formatConfig(payload)}\n\n`)
  const rl = createInterface({ input: stdin, output: stdout })
  const domain = (await rl.question(`平台域 feishu/lark [${current.domain}]: `)).trim().toLowerCase() || current.domain
  if (!['feishu', 'lark'].includes(domain)) throw new Error('平台域必须是 feishu 或 lark')
  const appId = (await rl.question(`App ID [${current.appId || '未配置'}]: `)).trim() || current.appId
  const allowInput = await rl.question(`允许用户 open_id（逗号分隔，输入 - 清空） [${current.allowedOpenIds.join(',')}]: `)
  const workspace = (await rl.question(`默认工作目录 [${current.defaultWorkspace}]: `)).trim() || current.defaultWorkspace
  const acknowledgement = await rl.question(`处理中提示（输入 - 关闭） [${current.acknowledgement}]: `)
  const allowGroupAt = yes(await rl.question(`允许群聊 @机器人？ [${current.allowGroupAt ? 'Y/n' : 'y/N'}]: `), current.allowGroupAt)
  const streamingEnabled = yes(await rl.question(`允许流式输出？ [${current.streamingEnabled ? 'Y/n' : 'y/N'}]: `), current.streamingEnabled)
  const fileTransferEnabled = yes(await rl.question(`允许通过飞书收发文件？ [${current.fileTransferEnabled ? 'Y/n' : 'y/N'}]: `), current.fileTransferEnabled)
  const maxFileInput = (await rl.question(`单个文件大小上限 MB [${current.maxFileSizeMb}]: `)).trim()
  const maxFileSizeMb = maxFileInput ? Number(maxFileInput) : current.maxFileSizeMb
  const enableNow = yes(await rl.question('配置保存后，现在测试凭据并启用飞书通道？ [y/N]: '), false)
  rl.close()
  const appSecret = await hiddenQuestion(`App Secret${payload.secretConfigured ? '（留空保持现有）' : ''}: `)
  const allowedOpenIds = allowInput.trim() === '-'
    ? []
    : allowInput.trim()
      ? allowInput.split(/[\s,，;；]+/).filter(Boolean)
      : current.allowedOpenIds
  let result = await client.saveConfig({
    ...current,
    domain,
    appId,
    allowedOpenIds,
    defaultWorkspace: workspace,
    acknowledgement: acknowledgement.trim() === '-' ? '' : acknowledgement || current.acknowledgement,
    allowGroupAt,
    streamingEnabled,
    fileTransferEnabled,
    maxFileSizeMb,
    enabled: false,
    ...(appSecret ? { appSecret } : {}),
  })
  stdout.write(`\n配置已保存，通道保持停用。\n${formatConfig(result)}\n`)
  if (enableNow) {
    try {
      await client.testCredentials({ appId, domain, ...(appSecret ? { appSecret } : {}) })
      result = await client.saveConfig({ ...result.config, confirmEnable: true })
      stdout.write(`\n凭据测试通过，通道已启用。\n${formatConfig(result)}\n`)
    } catch (error) {
      stdout.write(`\n凭据测试未通过，通道保持停用：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2))
  if (parsed.values.help || parsed.command === 'help') {
    stdout.write(HELP_TEXT)
    return
  }
  const client = new ConfigApiClient(parsed.values.url)
  if (parsed.command === 'show') {
    stdout.write(`${formatConfig(await client.getConfig())}\n`)
    return
  }
  if (parsed.command === 'configure') {
    await interactiveConfigure(client)
    return
  }
  if (parsed.command === 'test') {
    const appSecret = parsed.values['app-secret-stdin'] ? await readStdin() : undefined
    const result = await client.testCredentials({
      ...(parsed.values.domain ? { domain: parsed.values.domain } : {}),
      ...(parsed.values['app-id'] ? { appId: parsed.values['app-id'] } : {}),
      ...(appSecret ? { appSecret } : {}),
    })
    stdout.write(`${result.message}\n`)
    return
  }
  if (parsed.command === 'set' || parsed.command === 'enable' || parsed.command === 'disable') {
    const payload = await client.getConfig()
    const appSecret = parsed.values['app-secret-stdin'] ? await readStdin() : undefined
    const values = {
      ...parsed.values,
      ...(parsed.command === 'enable' ? { enable: true } : {}),
      ...(parsed.command === 'disable' ? { disable: true } : {}),
    }
    const nextConfig = configSavePayload(payload.config, values, appSecret)
    const result = await client.saveConfig(nextConfig)
    stdout.write(`${formatConfig(result)}\n`)
    return
  }
  if (parsed.command === 'allow') {
    const [action, ...ids] = parsed.positionals
    if (!['add', 'remove'].includes(action) || ids.length === 0) {
      throw new Error('用法：dsh-feishu-config allow add|remove <ou_xxx...>')
    }
    const payload = await client.getConfig()
    const existing = new Set(payload.config.allowedOpenIds)
    for (const id of ids) action === 'add' ? existing.add(id) : existing.delete(id)
    const nextConfig = configSavePayload(payload.config, { 'allow-open-id': [...existing] })
    const result = await client.saveConfig(nextConfig)
    stdout.write(`${formatConfig(result)}\n`)
    return
  }
  throw new Error(`未知命令：${parsed.command}\n\n${HELP_TEXT}`)
}

main().catch(error => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
