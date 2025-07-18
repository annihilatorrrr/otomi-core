import {
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
  V1ResourceRequirements,
  V1Secret,
} from '@kubernetes/client-node'
import retry, { Options } from 'async-retry'
import { AnyAaaaRecord, AnyARecord } from 'dns'
import { resolveAny } from 'dns/promises'
import { access, mkdir, writeFile } from 'fs/promises'
import { isEmpty, isEqual, map, mapValues } from 'lodash'
import { dirname, join } from 'path'
import { parse, stringify } from 'yaml'
import { $, cd, sleep } from 'zx'
import { DEPLOYMENT_PASSWORDS_SECRET, DEPLOYMENT_STATUS_CONFIGMAP } from './constants'
import { OtomiDebugger, terminal } from './debug'
import { env } from './envalid'
import { hfValues } from './hf'
import { getParsedArgs, parser } from './yargs'
import { askYesNo } from './zx-enhance'

export const secretId = `secret/otomi/${DEPLOYMENT_PASSWORDS_SECRET}`

// Warning don't use this with asynchronous code and multiple kubeconfigs it will override the kubeconfig
let kc: KubeConfig
let coreClient: CoreV1Api
let appClient: AppsV1Api
let batchClient: BatchV1Api
let customClient: CustomObjectsApi
export const k8s = {
  kc: (): KubeConfig => {
    if (kc) return kc
    kc = new KubeConfig()
    kc.loadFromDefault()
    return kc
  },
  core: (): CoreV1Api => {
    if (coreClient) return coreClient
    coreClient = k8s.kc().makeApiClient(CoreV1Api)
    return coreClient
  },
  app: (): AppsV1Api => {
    if (appClient) return appClient
    appClient = k8s.kc().makeApiClient(AppsV1Api)
    return appClient
  },
  batch: (): BatchV1Api => {
    if (batchClient) return batchClient
    batchClient = k8s.kc().makeApiClient(BatchV1Api)
    return batchClient
  },
  custom: (): CustomObjectsApi => {
    if (customClient) return customClient
    customClient = k8s.kc().makeApiClient(CustomObjectsApi)
    return customClient
  },
}

export const createK8sSecret = async (
  name: string,
  namespace: string,
  data: Record<string, any> | string,
): Promise<void> => {
  const d = terminal('common:k8s:createK8sSecret')
  const rawString = stringify(data)
  const filePath = join('/tmp', secretId)
  const dirPath = dirname(filePath)
  try {
    await access(dirPath)
  } catch (e) {
    await mkdir(dirPath, { recursive: true })
  }

  await writeFile(filePath, rawString)
  const result =
    await $`kubectl create secret generic ${name} -n ${namespace} --from-file ${filePath} --dry-run=client -o yaml | kubectl apply -f -`
      .nothrow()
      .quiet()
  if (result.stderr) d.error(result.stderr)
  d.debug(`kubectl create secret output: \n ${result.stdout}`)
}

export const isResourcePresent = async (type: string, name: string, namespace: string): Promise<boolean> => {
  try {
    await $`kubectl get -n ${namespace} ${type} ${name}`
  } catch {
    return false
  }
  return true
}

export const getK8sSecret = async (name: string, namespace: string): Promise<Record<string, any> | undefined> => {
  const result = await $`kubectl get secret ${name} -n ${namespace} -ojsonpath='{.data.${name}}' | base64 --decode`
    .nothrow()
    .quiet()
  if (result.exitCode === 0) return parse(result.stdout) as Record<string, any>
  return undefined
}

export interface DeploymentState {
  status?: 'deploying' | 'deployed'
  tag?: string
  version?: string
  deployingTag?: string
  deployingVersion?: string
}

export const getDeploymentState = async (): Promise<DeploymentState> => {
  if (env.isDev && env.DISABLE_SYNC) return {}
  const result = await $`kubectl get cm -n otomi ${DEPLOYMENT_STATUS_CONFIGMAP} -o jsonpath='{.data}'`.nothrow().quiet()
  return JSON.parse(result.stdout || '{}')
}

export const getHelmReleases = async (): Promise<Record<string, any>> => {
  const result = await $`helm list -A -a -o json`.nothrow().quiet()
  const data = JSON.parse(result.stdout || '[]') as []
  const status = data.reduce((acc, item) => {
    // eslint-disable-next-line no-param-reassign
    acc[`${item['namespace']}/${item['name']}`] = item
    return acc
  }, {})
  return status
}

export const setDeploymentState = async (state: Record<string, any>): Promise<void> => {
  if (env.isDev && env.DISABLE_SYNC) return
  const d = terminal('common:k8s:setDeploymentState')
  const currentState = await getDeploymentState()
  const newState = { ...currentState, ...state }
  const data = map(newState, (val, prop) => `--from-literal=${prop}=${val}`)
  const cmdCreate = `kubectl -n otomi create cm ${DEPLOYMENT_STATUS_CONFIGMAP} ${data.join(' ')}`
  const cmdPatch = `kubectl -n otomi patch cm ${DEPLOYMENT_STATUS_CONFIGMAP} --type merge -p {"data":${JSON.stringify(
    newState,
  )}}`
  const res = await $`${cmdPatch.split(' ')} || ${cmdCreate.split(' ')}`.nothrow().quiet()
  if (res.stderr) d.error(res.stderr)
}

const fetchLoadBalancerIngressData = async (): Promise<string> => {
  const d = terminal('common:k8s:fetchLoadBalancerIngressData')
  let ingressDataString = ''
  let count = 0
  for (;;) {
    ingressDataString = (
      await $`kubectl get -n ingress svc ingress-nginx-platform-controller -o jsonpath="{.status.loadBalancer.ingress}"`
    ).stdout.trim()
    count += 1
    if (ingressDataString) return ingressDataString
    await sleep(1000)
    d.debug(`Querying LoadBalancer IP information, trial #${count}`)
  }
}

interface IngressRecord {
  ip?: string
  hostname?: string
}
export const getOtomiLoadBalancerIP = async (): Promise<string> => {
  const d = terminal('common:k8s:getOtomiLoadBalancerIP')
  d.debug('Find LoadBalancer IP or Hostname')

  const ingressDataString = await fetchLoadBalancerIngressData()
  const ingressDataList = JSON.parse(ingressDataString) as IngressRecord[]
  // We sort by IP first, and order those, and then hostname and order them as well
  const ingressDataListSorted = [
    ...ingressDataList.filter((val) => !!val.ip).sort((a, b) => a.ip!.localeCompare(b.ip!)),
    ...ingressDataList.filter((val) => !!val.hostname).sort((a, b) => a.hostname!.localeCompare(b.hostname!)),
  ]

  d.debug(ingressDataListSorted)
  if (ingressDataListSorted.length === 0) throw new Error('No LoadBalancer Ingress definitions found')
  /* A load balancer can have a hostname, ip or any list of those items. We select the first item, as we only need one.
   * And we prefer IP over hostname, as it reduces the fact that we need to resolve & select an ip.
   */
  const [firstIngressData] = ingressDataListSorted

  if (firstIngressData.ip) return firstIngressData.ip
  if (firstIngressData.hostname) {
    // Wait until DNS records are propagated to the cluster DNS
    await waitTillAvailable(`https://${firstIngressData.hostname}`, {
      skipSsl: true,
      status: 404,
      maxTimeout: 10 * 1000, // retry every max 10 seconds, so no exponential backoff
      retries: 100, // we should have a LB within 100 * 10 secs (=14 minutes)
    })
    const resolveData = await resolveAny(firstIngressData.hostname)
    const resolveDataFiltered = resolveData.filter((val) => val.type === 'A' || val.type === 'AAAA') as (
      | AnyARecord
      | AnyAaaaRecord
    )[]
    /* Sorting the filtered list
     * Prefer IPv4 over IPv6; then sort by lowest address (basic string compare)
     * This way we get always the same first IP back on a cluster
     */
    const resolveDataSorted = resolveDataFiltered.sort((a, b) => {
      const typeCompare = a.type.localeCompare(b.type)
      return !typeCompare ? typeCompare : a.address.localeCompare(b.address)
    })

    if (isEmpty(resolveDataSorted))
      throw new Error(`No A or AAAA records found for ${firstIngressData.hostname} - could not determine IP`)
    /* For consistency reasons, after sorting (and preferring the lowest numbered IPv4 address) we pick the first one
     * As there can be multiple A or AAAA records, and we only need one
     */
    const firstIP = resolveDataSorted[0].address
    return firstIP
  }
  throw new Error('LoadBalancer Ingress data did not container ip or hostname')
}

/**
 * Check whether the environment matches the configuration for the kubernetes context
 * @returns
 */
export const checkKubeContext = async (): Promise<void> => {
  const d = terminal('common:k8s:checkKubeContext')
  d.info('Validating kube context')

  const values = await hfValues()
  const currentContext = (await $`kubectl config current-context`).stdout.trim()
  const k8sContext = values?.cluster?.k8sContext
  d.debug('currentContext: ', currentContext)
  d.debug('k8sContext: ', k8sContext)

  d.info(`Current kube context: ${currentContext}`)
  if (!k8sContext) {
    throw new Error('No value for cluster.k8sContext set!')
  }
  if (k8sContext !== currentContext) {
    let fixContext = false
    if (!parser.argv.setContext) {
      fixContext = await askYesNo(
        `Warning: Your current kubernetes context (${currentContext}) does not match cluster context: ${k8sContext}. Would you like to switch kube context to cluster first?`,
        { defaultYes: true },
      )
    }
    if (fixContext || parser.argv.setContext) {
      await $`kubectl config use ${k8sContext}`
    }
  }
}

type WaitTillAvailableOptions = Options & {
  status?: number
  skipSsl?: boolean
  username?: string
  password?: string
}

export const waitTillGitRepoAvailable = async (repoUrl: string): Promise<void> => {
  const d = terminal('common:k8s:waitTillGitRepoAvailable')
  await retry(
    async () => {
      try {
        cd(env.ENV_DIR)
        // the ls-remote exists with zero even if repo is empty
        await $`git ls-remote ${repoUrl}`
      } catch (e) {
        d.warn(`The values repository is not yet reachable. Retrying in ${env.MIN_TIMEOUT} ms`)
        throw e
      }
    },
    { retries: env.RETRIES, randomize: env.RANDOM, minTimeout: env.MIN_TIMEOUT, factor: env.FACTOR },
  )
}

export const waitTillAvailable = async (url: string, opts?: WaitTillAvailableOptions): Promise<void> => {
  const options = { status: 200, skipSsl: false, ...opts }
  const d = terminal('common:k8s:waitTillAvailable')
  const retryOptions: Options = {
    retries: 50,
    maxTimeout: 30000,
  }

  // NOTE: Native fetch does not allow a custom 'agent' or direct 'timeout'.
  // If you need special TLS handling, rely on environment variables
  // like NODE_TLS_REJECT_UNAUTHORIZED or NODE_EXTRA_CA_CERTS.
  const fetchOptions: RequestInit = {
    redirect: 'follow',
  }
  if (options.username && options.password) {
    fetchOptions.headers = {
      Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`,
    }
  }

  await retry(async (bail) => {
    try {
      const res = await fetch(url, fetchOptions)
      if (res.status !== options.status) {
        console.warn(`GET ${url} ${res.status} !== ${options.status}`)
        const err = new Error(`Wrong status code: ${res.status}`)
        // if we get a 404 or 503 we know some changes in either nginx or istio might still not be ready
        if (res.status !== 404 && res.status !== 503) {
          // but any other status code that is not the desired one tells us to stop retrying
          bail(err)
        } else throw err
      }
    } catch (e) {
      d.error(`GET ${url}`, e)
      throw e
    }
  }, retryOptions)
}

export async function createGenericSecret(
  coreV1Api: CoreV1Api,
  name: string,
  namespace: string,
  secretData: Record<string, string>,
): Promise<V1Secret> {
  const encodedData = mapValues(secretData, b64enc)

  const secret: V1Secret = {
    metadata: {
      name,
      namespace,
    },
    data: encodedData,
    type: 'Opaque',
  }

  return await coreV1Api.createNamespacedSecret({ namespace, body: secret })
}

export function b64enc(value: string): string {
  return Buffer.from(value).toString('base64')
}

export async function getPodsOfStatefulSet(
  appsApi: AppsV1Api,
  statefulSetName: string,
  namespace: string,
  coreApi: CoreV1Api,
) {
  const statefulSet = await appsApi.readNamespacedStatefulSet({ name: statefulSetName, namespace })

  if (!statefulSet.spec?.selector?.matchLabels) {
    throw new Error(`StatefulSet ${statefulSetName} does not have matchLabels`)
  }

  const labelSelector = Object.entries(statefulSet.spec.selector.matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')

  return await coreApi.listNamespacedPod({
    namespace,
    labelSelector,
  })
}

export async function patchContainerResourcesOfSts(
  statefulSetName: string,
  namespace: string,
  containerName: string,
  desiredResources: V1ResourceRequirements,
  appsApi: AppsV1Api,
  coreApi: CoreV1Api,
  d: OtomiDebugger,
) {
  try {
    const pods = await getPodsOfStatefulSet(appsApi, statefulSetName, namespace, coreApi)

    if (pods.items.length === 0) {
      d.error(`No pods found for StatefulSet ${statefulSetName}`)
      throw new Error(`No pods found for StatefulSet ${statefulSetName}`)
    }

    for (const pod of pods.items) {
      const actualResources = pod.spec?.containers?.find((container) => container.name === containerName)?.resources

      if (
        isEqual(actualResources?.limits, desiredResources?.limits) &&
        isEqual(actualResources?.requests, desiredResources?.requests)
      ) {
        d.info(
          `sts/argocd-application-controller pod has desired resources: ${JSON.stringify(
            desiredResources,
          )} and actual resources: ${JSON.stringify(actualResources)}`,
        )
        return
      }

      await patchStatefulSetResources(statefulSetName, containerName, namespace, desiredResources, appsApi, d)
      d.info(`sts/argocd-application-controller has been patched with resources: ${JSON.stringify(desiredResources)}`)

      await deleteStatefulSetPods(statefulSetName, namespace, appsApi, coreApi, d)
      d.info(`sts/argocd-application-controller pods restarted`)
    }
  } catch (error) {
    d.error(`Error patching StatefulSet ${statefulSetName}:`, error)
  }
}

export async function patchStatefulSetResources(
  statefulSetName: string,
  containerName: string,
  namespace: string,
  resources: V1ResourceRequirements,
  appsApi: AppsV1Api,
  d: OtomiDebugger,
) {
  try {
    const body = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: containerName,
                resources,
              },
            ],
          },
        },
      },
    }

    await appsApi.patchNamespacedStatefulSet(
      {
        name: statefulSetName,
        namespace,
        body,
      },
      setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch),
    )
  } catch (error) {
    d.error(`Failed to patch StatefulSet ${statefulSetName}:`, error)
  }
}

export async function deleteStatefulSetPods(
  statefulSetName: string,
  namespace: string,
  appsApi: AppsV1Api,
  coreApi: CoreV1Api,
  d: OtomiDebugger,
) {
  try {
    const pods = await getPodsOfStatefulSet(appsApi, statefulSetName, namespace, coreApi)

    if (pods.items.length === 0) {
      d.error(`No pods found for StatefulSet ${statefulSetName}`)
      throw new Error(`No pods found for StatefulSet ${statefulSetName}`)
    }

    // Delete each pod
    for (const pod of pods.items) {
      if (pod.metadata?.name) {
        await coreApi.deleteNamespacedPod({ name: pod.metadata.name, namespace })
      }
    }
  } catch (error) {
    d.error(`Failed to delete pods for StatefulSet ${statefulSetName}:`, error)
  }
}

// Core logic functions that can be easily tested
export async function checkArgoCDAppStatus(
  appName: string,
  customApi: CustomObjectsApi,
  statusPath: 'sync' | 'health',
  expectedValue: 'Synced' | 'Healthy',
): Promise<string> {
  const application = await customApi.getNamespacedCustomObject({
    group: 'argoproj.io',
    version: 'v1alpha1',
    namespace: 'argocd',
    plural: 'applications',
    name: appName,
  })

  const actualStatus = statusPath === 'sync' ? application?.status?.sync?.status : application?.status?.health?.status

  if (actualStatus !== expectedValue) {
    throw new Error(`Application ${appName} ${statusPath} status is '${actualStatus}', expected '${expectedValue}'`)
  }

  return actualStatus
}

export async function waitForArgoCDAppSync(
  appName: string,
  customApi: CustomObjectsApi,
  d: OtomiDebugger,
): Promise<void> {
  d.info(`Waiting for ArgoCD application '${appName}' to complete sync...`)

  await retry(
    async () => {
      try {
        await checkArgoCDAppStatus(appName, customApi, 'sync', 'Synced')
        d.info(`Application '${appName}' sync completed`)
      } catch (error) {
        d.warn(`Application '${appName}' is not synced yet: ${error.message}`)
        throw error
      }
    },
    { retries: env.RETRIES, randomize: env.RANDOM, minTimeout: env.MIN_TIMEOUT, factor: env.FACTOR },
  )
}

export async function waitForArgoCDAppHealthy(
  appName: string,
  customApi: CustomObjectsApi,
  d: OtomiDebugger,
): Promise<void> {
  d.info(`Waiting for ArgoCD application '${appName}' to be healthy...`)

  await retry(
    async () => {
      try {
        await checkArgoCDAppStatus(appName, customApi, 'health', 'Healthy')
        d.info(`Application '${appName}' is healthy`)
      } catch (error) {
        d.warn(`Application '${appName}' is not healthy yet: ${error.message}`)
        throw error
      }
    },
    { retries: env.RETRIES, randomize: env.RANDOM, minTimeout: env.MIN_TIMEOUT, factor: env.FACTOR },
  )
}

export async function restartOtomiApiDeployment(appApi: AppsV1Api): Promise<void> {
  const d = terminal('common:k8s:restartOtomiApiDeployment')

  try {
    d.info('Restarting otomi-api deployment')
    // This is equivalent to the 'kubectl rollout restart' command/
    // Read more at: https://kubernetes.io/docs/reference/labels-annotations-taints/#kubectl-k8s-io-restart-at
    await appApi.patchNamespacedDeployment(
      {
        name: 'otomi-api',
        namespace: 'otomi',
        body: {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
                },
              },
            },
          },
        },
      },
      setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch),
    )

    d.info('Successfully restarted otomi-api deployment')
  } catch (error) {
    d.error('Failed to restart otomi-api deployment:', error)
    throw error
  }
}

export async function applyServerSide(
  path: string,
  forceConflicts: boolean = false,
  dryRun: boolean = false,
): Promise<void> {
  const d = terminal('common:k8s:applyServerSide')
  d.debug(`Applying files from ${path}`)
  const kubectlArgs = ['-f', path]
  if (dryRun) {
    kubectlArgs.push('--dry-run=client')
  } else {
    kubectlArgs.push('--server-side')
    if (forceConflicts) {
      kubectlArgs.push('--force-conflicts')
    }
  }
  await $`kubectl apply ${kubectlArgs}`
}
