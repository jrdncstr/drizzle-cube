import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { defineCube } from '../src/server/cube-utils'
import { SemanticLayerCompiler } from '../src/server/compiler'
import type { BaseQueryDefinition, Cube, QueryContext, SemanticQuery } from '../src/server/types'
import {
  createTestDatabaseExecutor,
  getTestDatabaseType,
  getTestSchema,
  skipIfDatabend,
  skipIfDuckDB,
  skipIfSnowflake
} from './helpers/test-database'
import { reseedSQLiteRootInvariantFixture } from './helpers/databases/sqlite/setup'
import { reseedPostgresRootInvariantFixture } from './helpers/databases/postgres/setup'
import { reseedMySQLRootInvariantFixture } from './helpers/databases/mysql/setup'

const baselineOrganisationId = 9101
const foreignOrganisationId = 9202

interface RootInvariantTables {
  rootInvariantParents: any
  rootInvariantChildren: any
  rootInvariantFacts: any
}

function createRootInvariantCubes(
  tables: RootInvariantTables,
  parentCubeName = 'A'
): Map<string, Cube> {
  const { rootInvariantParents, rootInvariantChildren, rootInvariantFacts } = tables

  let parentCube: Cube
  let childCube: Cube
  let factCube: Cube

  parentCube = defineCube(parentCubeName, {
    title: 'Parent',
    sql: (context: QueryContext): BaseQueryDefinition => ({
      from: rootInvariantParents,
      where: eq(
        rootInvariantParents.organisationId,
        context.securityContext.organisationId as number
      )
    }),
    joins: {
      B: {
        targetCube: () => childCube,
        relationship: 'hasMany',
        on: [{ source: rootInvariantParents.identityKey, target: rootInvariantChildren.parentKey }]
      },
      C: {
        targetCube: () => factCube,
        relationship: 'hasMany',
        on: [{ source: rootInvariantParents.identityKey, target: rootInvariantFacts.parentKey }]
      }
    },
    dimensions: {
      name: { name: 'name', title: 'Name', type: 'string', sql: rootInvariantParents.name }
    },
    measures: {}
  })

  childCube = defineCube('B', {
    title: 'Child',
    sql: (context: QueryContext): BaseQueryDefinition => ({
      from: rootInvariantChildren,
      where: eq(
        rootInvariantChildren.organisationId,
        context.securityContext.organisationId as number
      )
    }),
    joins: {
      A: {
        targetCube: () => parentCube,
        relationship: 'belongsTo',
        on: [{ source: rootInvariantChildren.parentKey, target: rootInvariantParents.identityKey }]
      },
      C: {
        targetCube: () => factCube,
        relationship: 'hasMany',
        on: [{ source: rootInvariantChildren.simpleCorrelationKey, target: rootInvariantFacts.childCorrelationKey }]
      }
    },
    dimensions: {
      id: { name: 'id', title: 'ID', type: 'number', sql: rootInvariantChildren.id, primaryKey: true },
      name: { name: 'name', title: 'Name', type: 'string', sql: rootInvariantChildren.name }
    },
    measures: {}
  })

  factCube = defineCube('C', {
    title: 'Fact',
    sql: (context: QueryContext): BaseQueryDefinition => ({
      from: rootInvariantFacts,
      where: eq(
        rootInvariantFacts.organisationId,
        context.securityContext.organisationId as number
      )
    }),
    dimensions: {},
    measures: {
      count: { name: 'count', title: 'Count', type: 'count', sql: rootInvariantFacts.id },
      amountSum: { name: 'amountSum', title: 'Amount Sum', type: 'sum', sql: rootInvariantFacts.amount }
    }
  })

  return new Map([
    [parentCube.name, parentCube],
    [childCube.name, childCube],
    [factCube.name, factCube]
  ])
}

function createSemanticLayer(
  databaseExecutor: any,
  cubes: Map<string, Cube>
): SemanticLayerCompiler {
  const compiler = new SemanticLayerCompiler({ databaseExecutor })
  for (const cube of cubes.values()) {
    compiler.registerCube(cube)
  }
  return compiler
}

async function reseedRootInvariantFixture(db: any): Promise<void> {
  switch (getTestDatabaseType()) {
    case 'sqlite':
      await reseedSQLiteRootInvariantFixture(db)
      return
    case 'postgres':
      await reseedPostgresRootInvariantFixture(db)
      return
    case 'mysql':
      await reseedMySQLRootInvariantFixture(db)
      return
    default:
      throw new Error(`Root-invariant fixture does not support ${getTestDatabaseType()}`)
  }
}

function sortRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) =>
    String(left['B.name']).localeCompare(String(right['B.name']))
  )
}

function withoutChildId(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return sortRows(rows.map(row => {
    const { 'B.id': childId, ...rest } = row
    void childId
    return rest
  }))
}

const expectedChildRows = [
  { 'A.name': 'a1', 'B.name': 'b1', 'C.count': 3, 'C.amountSum': 6 },
  { 'A.name': 'a1', 'B.name': 'b2', 'C.count': 2, 'C.amountSum': 9 },
  { 'A.name': 'a1', 'B.name': 'b3', 'C.count': null, 'C.amountSum': null }
]

const skipRootInvariantFixture =
  skipIfDuckDB() || skipIfDatabend() || skipIfSnowflake() || getTestDatabaseType() === 'both'

describe.skipIf(skipRootInvariantFixture)('root-invariant measure grain', () => {
  let close: () => void
  let db: any
  let databaseExecutor: any
  let semanticLayer: SemanticLayerCompiler
  let tables: RootInvariantTables

  beforeAll(async () => {
    const database = await createTestDatabaseExecutor()
    close = database.close
    databaseExecutor = database.executor
    db = database.executor.db

    const schema = await getTestSchema()
    tables = {
      rootInvariantParents: schema.rootInvariantParents,
      rootInvariantChildren: schema.rootInvariantChildren,
      rootInvariantFacts: schema.rootInvariantFacts
    }

    await reseedRootInvariantFixture(db)
    await reseedRootInvariantFixture(db)

    semanticLayer = createSemanticLayer(
      databaseExecutor,
      createRootInvariantCubes(tables)
    )
  })

  afterAll(() => {
    close()
  })

  test('repeated setup preserves the exact parent-child-fact fixture', async () => {
    const parents = await db.select().from(tables.rootInvariantParents)
    const children = await db.select().from(tables.rootInvariantChildren)
    const facts = await db.select().from(tables.rootInvariantFacts)

    expect(parents).toHaveLength(2)
    expect(children).toHaveLength(6)
    expect(facts).toHaveLength(10)

    const organisationIds = new Set([
      ...parents.map((row: any) => row.organisationId),
      ...children.map((row: any) => row.organisationId),
      ...facts.map((row: any) => row.organisationId)
    ])
    expect([...organisationIds].sort((left, right) => left - right)).toEqual([
      baselineOrganisationId,
      foreignOrganisationId
    ])

    for (const organisationId of [baselineOrganisationId, foreignOrganisationId]) {
      const organisationParents = parents.filter((row: any) => row.organisationId === organisationId)
      const organisationChildren = children.filter((row: any) => row.organisationId === organisationId)
      const organisationFacts = facts.filter((row: any) => row.organisationId === organisationId)

      expect(organisationParents).toHaveLength(1)
      expect(organisationChildren).toHaveLength(3)
      expect(organisationFacts).toHaveLength(5)
      expect(organisationFacts.reduce((total: number, row: any) => total + Number(row.amount), 0)).toBe(15)

      const parentKeys = new Set(organisationParents.map((row: any) => row.identityKey))
      expect(organisationChildren.every((row: any) => parentKeys.has(row.parentKey))).toBe(true)
      expect(organisationFacts.every((row: any) => parentKeys.has(row.parentKey))).toBe(true)

      const childCorrelationKeys = new Set(
        organisationChildren.map((row: any) => row.simpleCorrelationKey)
      )
      expect(organisationFacts.every((row: any) => childCorrelationKeys.has(row.childCorrelationKey))).toBe(true)
      expect(
        organisationFacts.some((row: any) => row.childCorrelationKey === 'correlation-3')
      ).toBe(false)
    }
  })

  test('parent-rooted child groups correlate facts without losing zero-fact children', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    const dryRun = await semanticLayer.dryRun(query, securityContext)
    const sql = dryRun.sql.toLowerCase()

    expect(analysis.primaryCube.selectedCube).toBe('A')
    expect(sql).toContain('with')
    expect(sql.indexOf('root_invariant_parents')).toBeLessThan(sql.indexOf('root_invariant_children'))
    expect(dryRun.params).toContain(baselineOrganisationId)
    expect(dryRun.params).not.toContain(foreignOrganisationId)

    const result = await semanticLayer.execute(query, securityContext)

    expect(sortRows(result.data)).toEqual(expectedChildRows)
  })

  test('adding a visible child key changes the root without changing child totals', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name', 'B.id'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const result = await semanticLayer.execute(query, securityContext)

    expect(result.data.every(row => row['B.id'] !== undefined)).toBe(true)
    expect(withoutChildId(result.data)).toEqual(expectedChildRows)
  })

  test('renaming the parent flips the tie-break without changing child totals', async () => {
    const renamedSemanticLayer = createSemanticLayer(
      databaseExecutor,
      createRootInvariantCubes(tables, 'Z')
    )
    const query: SemanticQuery = {
      dimensions: ['Z.name', 'B.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = renamedSemanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const result = await renamedSemanticLayer.execute(query, securityContext)
    const normalized = sortRows(result.data).map(row => ({
      'A.name': row['Z.name'],
      'B.name': row['B.name'],
      'C.count': row['C.count'],
      'C.amountSum': row['C.amountSum']
    }))

    expect(normalized).toEqual(expectedChildRows)
  })

  test('parent-only grouping keeps the direct fact total', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('A')

    const result = await semanticLayer.execute(query, securityContext)
    expect(result.data).toEqual([
      { 'A.name': 'a1', 'C.count': 5, 'C.amountSum': 15 }
    ])
  })
})
