import type { Cube, JoinKeyInfo, SemanticQuery } from './types/index.js'
import type { CTEJoinKey } from './logical-plan/cte-planner-helpers.js'
import { deriveCTEJoinKeys } from './logical-plan/cte-planner-helpers.js'
import type { JoinRef } from './logical-plan/types.js'
import type { JoinPathResolver } from './resolvers/join-path-resolver.js'
import { analyzeCubeUsage } from './logical-plan/planner-utils.js'

const cteCorrelationMetadata: unique symbol = Symbol('cteCorrelationMetadata')

export interface CTECorrelationSet {
  cubeName: string
  joinKeys: CTEJoinKey[]
}

export interface CTECorrelationMetadata {
  correlationSets: CTECorrelationSet[]
}

type MetadataCarrier = Record<PropertyKey, unknown>

export function attachCTECorrelationMetadata(
  target: object,
  metadata: CTECorrelationMetadata | undefined
): void {
  if (!metadata || metadata.correlationSets.length === 0) {
    delete (target as MetadataCarrier)[cteCorrelationMetadata]
    return
  }

  Object.defineProperty(target, cteCorrelationMetadata, {
    value: metadata,
    enumerable: true,
    configurable: true
  })
}

export function readCTECorrelationMetadata(
  source: object
): CTECorrelationMetadata | undefined {
  return (source as MetadataCarrier)[cteCorrelationMetadata] as CTECorrelationMetadata | undefined
}

export function isRetainedCorrelationCube(
  cte: object,
  cubeName: string
): boolean {
  return readCTECorrelationMetadata(cte)?.correlationSets.some(
    correlationSet => correlationSet.cubeName === cubeName
  ) ?? false
}

export function copyCTECorrelationMetadata(source: object, target: object): void {
  attachCTECorrelationMetadata(target, readCTECorrelationMetadata(source))
}

export function orderJoinsForCTECorrelations(
  joins: JoinRef[],
  ctes: Array<{ cube: { name: string } }>
): JoinRef[] {
  if (joins.length < 2 || ctes.length === 0) {
    return joins
  }

  const indexByCube = new Map(joins.map((join, index) => [join.target.name, index]))
  const outgoing = new Map<number, Set<number>>()
  const indegree = joins.map(() => 0)

  for (const cte of ctes) {
    const dependentIndex = indexByCube.get(cte.cube.name)
    if (dependentIndex === undefined) continue

    const metadata = readCTECorrelationMetadata(cte)
    for (const correlationSet of metadata?.correlationSets ?? []) {
      const predecessorIndex = indexByCube.get(correlationSet.cubeName)
      if (predecessorIndex === undefined || predecessorIndex === dependentIndex) continue

      let targets = outgoing.get(predecessorIndex)
      if (!targets) {
        targets = new Set()
        outgoing.set(predecessorIndex, targets)
      }
      if (!targets.has(dependentIndex)) {
        targets.add(dependentIndex)
        indegree[dependentIndex] += 1
      }
    }
  }

  const ready = indegree
    .map((degree, index) => degree === 0 ? index : -1)
    .filter(index => index >= 0)
  const ordered: JoinRef[] = []

  while (ready.length > 0) {
    ready.sort((left, right) => left - right)
    const index = ready.shift()!
    ordered.push(joins[index])

    for (const targetIndex of outgoing.get(index) ?? []) {
      indegree[targetIndex] -= 1
      if (indegree[targetIndex] === 0) {
        ready.push(targetIndex)
      }
    }
  }

  if (ordered.length !== joins.length) {
    throw new Error('CTE correlation join dependency cycle')
  }

  return ordered
}

export function deriveCTECorrelationMetadata(
  cubes: Map<string, Cube>,
  factCube: Cube,
  query: SemanticQuery,
  rootJoinKeys: JoinKeyInfo[],
  resolver: JoinPathResolver
): CTECorrelationMetadata | undefined {
  const groupingCubeNames = collectGroupingCubeNames(query, factCube.name)
  const preferredCubes = analyzeCubeUsage(query)
  const paths = new Map<string, NonNullable<ReturnType<JoinPathResolver['findPathPreferring']>>>()

  for (const cubeName of groupingCubeNames) {
    const path = resolver.findPathPreferring(cubeName, factCube.name, preferredCubes, new Set())
    if (path && path.length > 0) {
      paths.set(cubeName, path)
    }
  }

  const groupingCubeSet = new Set(groupingCubeNames)
  const frontierCubeNames = groupingCubeNames.filter(cubeName => {
    const path = paths.get(cubeName)
    if (!path) return false

    return !path.slice(0, -1).some(step =>
      step.toCube !== factCube.name && groupingCubeSet.has(step.toCube)
    )
  })

  const correlationSets: CTECorrelationSet[] = []
  for (const cubeName of frontierCubeNames) {
    const groupingCube = cubes.get(cubeName)
    const path = paths.get(cubeName)
    if (!groupingCube || !path) continue

    const finalStep = path[path.length - 1]
    const definingCube = finalStep.reversed
      ? cubes.get(finalStep.toCube)
      : cubes.get(finalStep.fromCube)
    if (!definingCube) continue

    const joinKeys = deriveCTEJoinKeys(
      {
        sourceCube: definingCube,
        joinDef: finalStep.joinDef,
        reversed: finalStep.reversed
      },
      groupingCube
    )

    if (sameJoinKeys(joinKeys, rootJoinKeys)) {
      continue
    }

    correlationSets.push({ cubeName, joinKeys })
  }

  return correlationSets.length > 0 ? { correlationSets } : undefined
}

function collectGroupingCubeNames(query: SemanticQuery, factCubeName: string): string[] {
  const names = new Set<string>()

  for (const dimension of query.dimensions ?? []) {
    const [cubeName] = dimension.split('.')
    if (cubeName && cubeName !== factCubeName) names.add(cubeName)
  }

  for (const timeDimension of query.timeDimensions ?? []) {
    const [cubeName] = timeDimension.dimension.split('.')
    if (cubeName && cubeName !== factCubeName) names.add(cubeName)
  }

  return [...names].sort()
}

function sameJoinKeys(left: CTEJoinKey[], right: JoinKeyInfo[]): boolean {
  if (left.length !== right.length) return false

  return left.every((leftKey, index) => {
    const rightKey = right[index]
    return leftKey.sourceColumnObj === rightKey.sourceColumnObj
      && leftKey.targetColumnObj === rightKey.targetColumnObj
  })
}
