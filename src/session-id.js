import { createHash } from 'node:crypto'

export function stableFeishuSessionId(chatKey, presetId) {
  const digest = createHash('sha256').update(`${presetId}\0${chatKey}`).digest('hex').slice(0, 24)
  // Presets define the tool protocol visible to a session. Including the
  // preset id prevents a default-preset change from replaying incompatible
  // tool history into a newly composed Feishu agent.
  return `feishu-v3-${digest}`
}
