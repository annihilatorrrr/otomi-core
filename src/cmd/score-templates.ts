import { existsSync, unlinkSync } from 'fs'
import { Argv } from 'yargs'
import { $, nothrow } from 'zx'
import { cleanupHandler, prepareEnvironment } from '../common/cli'
import { terminal } from '../common/debug'
import { hfTemplate } from '../common/hf'
import { getFilename } from '../common/utils'
import { getParsedArgs, HelmArguments, helmOptions, setParsedArgs } from '../common/yargs'

const cmdName = getFilename(__filename)
const templatePath = '/tmp/template.yaml'

const cleanup = (argv: HelmArguments): void => {
  if (argv.skipCleanup) return
  if (existsSync(templatePath)) unlinkSync(templatePath)
}

const setup = (argv: HelmArguments): void => {
  cleanupHandler(() => cleanup(argv))
}

const scoreTemplate = async (): Promise<void> => {
  const d = terminal(`cmd:${cmdName}:score`)
  const argv: HelmArguments = getParsedArgs()
  d.info('Scoring STARTED')
  await hfTemplate(argv, templatePath)
  d.info('Scoring DONE')

  const scoreResult = await nothrow($`kube-score score ${templatePath}`)
  d.log(scoreResult.stdout.trim())
}

export const module = {
  command: cmdName,
  describe: undefined,
  builder: (parser: Argv): Argv => helmOptions(parser),

  handler: async (argv: HelmArguments): Promise<void> => {
    setParsedArgs(argv)
    await prepareEnvironment({ skipKubeContextCheck: true })
    setup(argv)
    await scoreTemplate()
  },
}
