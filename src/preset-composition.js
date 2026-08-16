/** Resolve and bind the deployment's current default Agent Preset. */
export async function resolveDefaultAgentPreset(agentPresets) {
  const preset = await agentPresets.resolve()
  return {
    id: preset.id,
    mount: agentCtx => agentPresets.mount(agentCtx, preset.id),
  }
}
