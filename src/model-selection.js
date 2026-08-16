/**
 * Install the model selected by the deployment's agentDefaultModel service
 * into both prompt assembly and the outbound LLM request for one Agent.
 */
export function installAgentModelSelection(agentCtx, selection) {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (!selected) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (!selected) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
