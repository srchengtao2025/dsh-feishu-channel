import { parseArgs } from 'node:util'

export function parseModelCliArgs(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      'dsh-home': { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'reasoning-effort': { type: 'string' },
      'clear-reasoning-effort': { type: 'boolean', default: false },
      ref: { type: 'string' },
      'api-key-stdin': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  return { command: parsed.positionals[0] ?? 'show', positionals: parsed.positionals.slice(1), values: parsed.values }
}

export const MODEL_HELP_TEXT = `DSH 模型配置 CLI

用法：dsh-model-config <命令> [选项]

命令：
  show                         查看默认模型和已配置凭据引用
  set-default                  设置全局默认模型
  reset-default                恢复 profile 内置默认模型
  set-deepseek                 配置 DeepSeek 官方模型，可从 stdin 写入 API Key
  credential set               从 stdin 写入一个 API Key
  credential unset             删除一个凭据引用

选项：
  --provider <名称>            Provider，默认 deepseek-official
  --model <模型 ID>            模型 ID，例如 deepseek-v4-pro
  --reasoning-effort <值>      设置推理档位
  --clear-reasoning-effort     清除已保存的推理档位
  --ref <凭据引用>             默认 DEEPSEEK_API_KEY
  --api-key-stdin              从 stdin 安全读取 API Key
  --dsh-home <目录>            DSH_HOME，默认 $DSH_HOME 或 /var/lib/dsh/.dsh

示例：
  dsh-model-config show
  dsh-model-config set-default --provider deepseek-official --model deepseek-v4-pro
  dsh-model-config set-default --model deepseek-v4-pro --reasoning-effort high
  printf '%s' "$DEEPSEEK_API_KEY" | dsh-model-config set-deepseek --model deepseek-v4-pro --api-key-stdin
`
