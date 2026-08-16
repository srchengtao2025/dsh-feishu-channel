import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, errorFromTurnEnd, hasUnparsedToolProtocol, parseFeishuMessageEvent, parseFeishuTextEvent, textDeltaFromAssistantChunk, textFromAssistantMessage } from '../src/message.js'

test('parses text events and removes bot mention placeholders', () => {
  const result = parseFeishuTextEvent({ event: {
    sender: { sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 请检查服务' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    },
  } }, 'ou_bot')
  assert.deepEqual(result, { ok: true, value: {
    messageId: 'om_1', chatId: 'oc_1', chatType: 'group', openId: 'ou_user',
    text: '请检查服务', mentionsBot: true, messageType: 'text',
  } })
})

test('parses file and image resource messages', () => {
  const base = {
    sender: { sender_id: { open_id: 'ou_user' } },
    message: { message_id: 'om_file', chat_id: 'oc_1', chat_type: 'p2p' },
  }
  const file = parseFeishuMessageEvent({ event: {
    ...base,
    message: { ...base.message, message_type: 'file', content: JSON.stringify({ file_key: 'file_key_1', file_name: '../report.pdf' }) },
  } })
  assert.equal(file.value.messageType, 'file')
  assert.deepEqual(file.value.resource, { type: 'file', fileKey: 'file_key_1', fileName: '../report.pdf' })

  const image = parseFeishuMessageEvent({ event: {
    ...base,
    message: { ...base.message, message_type: 'image', content: JSON.stringify({ image_key: 'image_key_1' }) },
  } })
  assert.equal(image.value.resource.type, 'image')
})

test('extracts text blocks and chunks long replies', () => {
  assert.equal(textFromAssistantMessage({ content: [
    { type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' },
  ] }), 'ab')
  assert.deepEqual(chunkText('12345\n67890', 7), ['12345', '67890'])
})

test('extracts terminal agent errors so they are not reported as empty replies', () => {
  const error = { code: 'UNKNOWN', message: 'prompt assembly failed' }
  assert.equal(errorFromTurnEnd({ type: 'assistant/message', data: {} }), undefined)
  assert.equal(errorFromTurnEnd({ type: 'turn/end', data: { reason: { kind: 'error', error } } }), error)
})

test('detects leaked DSML tool protocol without matching ordinary text', () => {
  assert.equal(hasUnparsedToolProtocol('<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="Bash">'), true)
  assert.equal(hasUnparsedToolProtocol('本文介绍 DSML，但不包含内部调用。'), false)
})

test('extracts only visible assistant text deltas for streaming', () => {
  assert.equal(textDeltaFromAssistantChunk({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '增量' } } }), '增量')
  assert.equal(textDeltaFromAssistantChunk({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: '思考' } } }), '')
})
