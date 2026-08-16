import { hasUnparsedToolProtocol } from './message.js'

const DEFAULT_HOLDBACK = 64

function protocolStart(text) {
  const markers = ['<｜｜DSML', '<||DSML', '<|DSML']
  const indexes = markers.map(marker => text.indexOf(marker)).filter(index => index >= 0)
  return indexes.length ? Math.min(...indexes) : -1
}

/**
 * Serializes DSH text deltas into accumulated snapshots for a Feishu stream.
 * A short tail is withheld so an internal DSML marker split across chunks is
 * detected before any part of that marker reaches the user.
 */
export class SafeStreamRelay {
  constructor(controller, { holdbackChars = DEFAULT_HOLDBACK } = {}) {
    this.controller = controller
    this.holdbackChars = holdbackChars
    this.text = ''
    this.sent = ''
    this.tail = Promise.resolve()
    this.blocked = false
  }

  push(delta) {
    if (!delta || this.blocked) return
    this.text += delta
    const start = protocolStart(this.text)
    if (start >= 0 && hasUnparsedToolProtocol(this.text)) {
      this.blocked = true
      this.enqueue(this.text.slice(0, start).trimEnd())
      return
    }
    const visibleLength = Math.max(0, this.text.length - this.holdbackChars)
    this.enqueue(this.text.slice(0, visibleLength))
  }

  enqueue(snapshot) {
    if (!snapshot || snapshot === this.sent) return
    this.sent = snapshot
    this.tail = this.tail.then(() => this.controller.setContent(snapshot))
  }

  async flush() {
    await this.tail
  }

  async complete(finalText) {
    await this.flush()
    if (hasUnparsedToolProtocol(finalText)) {
      throw new Error('模型返回了未解析的工具调用协议；已阻止内部协议文本发送到飞书。')
    }
    this.sent = finalText
    await this.controller.setContent(finalText)
  }
}
