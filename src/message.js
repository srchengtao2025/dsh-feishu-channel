export function parseFeishuMessageEvent(payload, botOpenId) {
  const event = payload?.event ?? payload
  const message = event?.message
  const sender = event?.sender
  if (!message || !sender) return { ok: false, reason: '消息事件结构不完整' }
  const messageType = String(message.message_type ?? '')
  if (!['text', 'file', 'image'].includes(messageType)) return { ok: false, reason: '目前仅支持文本、文件和图片消息' }

  let content
  try {
    content = JSON.parse(message.content ?? '{}')
  } catch {
    return { ok: false, reason: '消息内容不是有效 JSON' }
  }

  let text = messageType === 'text' ? String(content.text ?? '').trim() : ''
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const mentionsBot = botOpenId
    ? mentions.some(item => item?.id?.open_id === botOpenId)
    : mentions.length > 0
  for (const mention of mentions) {
    if (!mention?.key) continue
    text = text.replaceAll(mention.key, '').trim()
  }

  const resource = messageType === 'file'
    ? { type: 'file', fileKey: String(content.file_key ?? ''), fileName: String(content.file_name ?? '') }
    : messageType === 'image'
      ? { type: 'image', fileKey: String(content.image_key ?? ''), fileName: `image-${String(message.message_id ?? 'unknown')}` }
      : undefined
  if (resource && !resource.fileKey) return { ok: false, reason: '文件消息缺少资源 key' }

  return {
    ok: true,
    value: {
      messageId: String(message.message_id ?? ''),
      chatId: String(message.chat_id ?? ''),
      chatType: String(message.chat_type ?? ''),
      openId: String(sender.sender_id?.open_id ?? ''),
      text,
      mentionsBot,
      messageType,
      ...(resource ? { resource } : {}),
    },
  }
}

export const parseFeishuTextEvent = parseFeishuMessageEvent

export function textFromAssistantMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim()
}

export function errorFromTurnEnd(event) {
  if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'error') return undefined
  return event.data.reason.error
}

export function textDeltaFromAssistantChunk(event) {
  if (event?.type !== 'assistant/chunk' || event.data?.chunk?.type !== 'text-delta') return ''
  return typeof event.data.chunk.text === 'string' ? event.data.chunk.text : ''
}

export function hasUnparsedToolProtocol(text) {
  const value = String(text ?? '')
  return value.includes('DSML') && value.includes('tool_calls') && value.includes('invoke')
}

export function chunkText(text, maxLength = 3500) {
  const chunks = []
  let rest = String(text ?? '').trim()
  while (rest.length > maxLength) {
    let splitAt = rest.lastIndexOf('\n', maxLength)
    if (splitAt < Math.floor(maxLength * 0.5)) splitAt = maxLength
    chunks.push(rest.slice(0, splitAt).trim())
    rest = rest.slice(splitAt).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}
