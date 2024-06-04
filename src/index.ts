import yargs from 'yargs'
import fs from 'fs-extra'
import execa from 'execa'
import pkgDir from 'pkg-dir'
import path from 'path'
import prettier from 'prettier'

interface WorkSpaceInfo {
  [key: string]: {
    location: string
    workspaceDependencies: string[]
  }
}

function isNotUndefined<T>(x: T | undefined): x is T {
  return x !== undefined
}

const stringifyTSConfig = async (
  tsConfig: any,
  path: string,
): Promise<string> => {
  const text = JSON.stringify(tsConfig, null, 2)
  const prettierOptions = await prettier.resolveConfig(path)
  return prettier.format(text, {
    ...prettierOptions,
    parser: 'json',
  })
}

const run = async ({ mode }: { mode: 'check' | 'write' }) => {
  const root = await pkgDir(process.cwd())
  if (!root) {
    throw new Error('Could not find workspace root.')
  }
  const rootTSConfigPath = path.join(root, 'tsconfig.json')
  const { stdout: raw } = await execa('yarn', [
    'workspaces',
    'list',
    '--json',
    '--verbose',
  ])

  const workspaceInfo: WorkSpaceInfo = {}

  for (const line of raw.split('\n')) {
    const info = JSON.parse(line)
    workspaceInfo[info.name] = info
  }
  const packageNames = Object.keys(workspaceInfo)

  const getPackageInfo = async (name: string) => {
    const info = workspaceInfo[name]
    const tsConfigPath = path.join(root, info.location, 'tsconfig.json')
    const tsConfigExists = await fs.pathExists(tsConfigPath)
    if (tsConfigExists) {
      var tsConfig = JSON.parse(await fs.readFile(tsConfigPath, {
        encoding: 'utf8',
      }))
    }
    return {
      tsConfigPath: tsConfigExists ? tsConfigPath : undefined,
      name,
      location: info.location,
      isComposite: !!tsConfig?.compilerOptions?.composite,
    }
  }

  const idk: {
    tsConfigPath: string | undefined
    name: string,
    isComposite: boolean,
    location: string,
  }[] = await Promise.all(
    packageNames.map(async (name) => getPackageInfo(name)),
  )

  const nameToConfigPath: {
    [name: string]: string | undefined
  } = idk.reduce(
    (acc: any, next) => ({ ...acc, [next.name]: next.tsConfigPath }),
    {},
  )

  const compositePackages = new Set(idk.filter(v => v.isComposite).map(v => v.location))

  const processPackage = async (
    name: string,
  ): Promise<{ wasOutOfSync: boolean; wasWritten: boolean } | {}> => {
    const info = workspaceInfo[name]
    const tsConfigPath = nameToConfigPath[name]
    if (tsConfigPath) {
      const tsConfigString = await fs.readFile(tsConfigPath, {
        encoding: 'utf8',
      })
      const tsConfig = JSON.parse(tsConfigString)
      const tsConfigTarget = {
        ...tsConfig,
        references: info.workspaceDependencies
          .filter(isNotUndefined)
          .filter(v => compositePackages.has(v) && v !== info.location)
          .map((v) => path.relative(info.location, v))
          .map((v) => ({ path: v })),
      }
      const tsConfigTargetString = await stringifyTSConfig(
        tsConfigTarget,
        tsConfigPath,
      )

      const tsConfigMatchesTarget = tsConfigString === tsConfigTargetString

      if (mode === 'write') {
        if (!tsConfigMatchesTarget) {
          await fs.writeFile(tsConfigPath, tsConfigTargetString)
          return { wasOutOfSync: true, wasWritten: true }
        } else {
          return { wasOutOfSync: false, wasWritten: false }
        }
      }

      if (mode === 'check') {
        if (!tsConfigMatchesTarget) {
          return { wasOutOfSync: true, wasWritten: false }
        } else {
          return { wasOutOfSync: false, wasWritten: false }
        }
      }

      throw new Error(`Invalid mode: ${mode}`)
    }
    return {}
  }

  const infoAboutPackages: any[] = []
  await Promise.all(
    packageNames.map(async (name) => {
      const i = await processPackage(name)
      infoAboutPackages.push(i)
    }),
  )

  const rootTSConfigString = await fs.readFile(rootTSConfigPath, {
    encoding: 'utf8',
  })
  const rootTSConfigTarget = {
    files: [],
    references: idk
      .map((v) => v.tsConfigPath)
      .filter(isNotUndefined)
      .map((v) => path.relative(root, v))
      .map((v) => ({ path: v })),
  }
  const rootTSConfigTargetString = await stringifyTSConfig(
    rootTSConfigTarget,
    rootTSConfigPath,
  )

  const rootTSConfigMatchesTarget =
    rootTSConfigString === rootTSConfigTargetString

  if (mode === 'check') {
    if (
      infoAboutPackages.some((v) => v.wasOutOfSync) ||
      !rootTSConfigMatchesTarget
    ) {
      console.error(
        'Project references are not in sync with dependencies.\nYou can run "yarn yarn-workspaces-to-typescript-project-references write" to fix them.',
      )
      process.exit(1)
    }
  } else {
    if (
      infoAboutPackages.some((v) => v.wasOutOfSync) ||
      !rootTSConfigMatchesTarget
    ) {
      await fs.writeFile(rootTSConfigPath, rootTSConfigTargetString)
      console.log('Project references were synced with dependencies.')
      process.exit(0)
    } else {
      console.log('Project references are in sync with dependencies.')
      process.exit(0)
    }
  }
}

yargs
  .command(
    'check',
    'Check that the tsconfig file project references are synced with dependencies.',
    (v: any) => v,
    async () => {
      await run({ mode: 'check' })
    },
  )
  .command(
    'write',
    'Write the dependencies to tsconfig file project references.',
    (v: any) => v,
    async () => {
      await run({ mode: 'write' })
    },
  )
  .parse()
