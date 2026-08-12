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
const equalSelectedValueOrganisationId = 9303
const compositeCollisionOrganisationId = 9404

/** Exact fixture shape per reserved organisation namespace, in ascending id order. */
const expectedOrganisationCounts = new Map([
  [baselineOrganisationId, { parents: 1, children: 3, facts: 5 }],
  [foreignOrganisationId, { parents: 1, children: 3, facts: 5 }],
  [equalSelectedValueOrganisationId, { parents: 1, children: 2, facts: 5 }],
  [compositeCollisionOrganisationId, { parents: 1, children: 3, facts: 5 }]
])

interface RootInvariantTables {
  rootInvariantParents: any
  rootInvariantChildren: any
  rootInvariantFacts: any
}

interface RootInvariantCubeOptions {
  /** 'composite' replaces the single child-to-fact correlation column with a two-part key. */
  childToFactCorrelation?: 'simple' | 'composite'
  /** true makes the fact cube declare `belongsTo` back to both the parent and the child. */
  factDeclaresBackReferences?: boolean
}

function createRootInvariantCubes(
  tables: RootInvariantTables,
  parentCubeName = 'A',
  options: RootInvariantCubeOptions = {}
): Map<string, Cube> {
  const { rootInvariantParents, rootInvariantChildren, rootInvariantFacts } = tables
  const childToFactOn = options.childToFactCorrelation === 'composite'
    ? [
        {
          source: rootInvariantChildren.compositeCorrelationKeyA,
          target: rootInvariantFacts.compositeCorrelationKeyA
        },
        {
          source: rootInvariantChildren.compositeCorrelationKeyB,
          target: rootInvariantFacts.compositeCorrelationKeyB
        }
      ]
    : [
        {
          source: rootInvariantChildren.simpleCorrelationKey,
          target: rootInvariantFacts.childCorrelationKey
        }
      ]

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
      identityKey: {
        name: 'identityKey',
        title: 'Identity Key',
        type: 'string',
        sql: rootInvariantParents.identityKey
      },
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
        on: childToFactOn
      }
    },
    dimensions: {
      id: { name: 'id', title: 'ID', type: 'number', sql: rootInvariantChildren.id, primaryKey: true },
      identityKey: {
        name: 'identityKey',
        title: 'Identity Key',
        type: 'string',
        sql: rootInvariantChildren.identityKey
      },
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
    joins: options.factDeclaresBackReferences
      ? {
          [parentCubeName]: {
            targetCube: () => parentCube,
            relationship: 'belongsTo' as const,
            on: [{ source: rootInvariantFacts.parentKey, target: rootInvariantParents.identityKey }]
          },
          B: {
            targetCube: () => childCube,
            relationship: 'belongsTo' as const,
            on: childToFactOn.map(component => ({
              source: component.target,
              target: component.source
            }))
          }
        }
      : undefined,
    dimensions: {
      amount: { name: 'amount', title: 'Amount', type: 'number', sql: rootInvariantFacts.amount }
    },
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

/** The two-part child-to-fact correlation key, as one comparable string. */
function compositeKey(row: any): string {
  return `${row.compositeCorrelationKeyA}|${row.compositeCorrelationKeyB}`
}

/** Fact amounts a child owns under the given correlation projection, in ascending order. */
function correlatedAmounts(
  facts: any[],
  child: any,
  project: (row: any) => string
): number[] {
  return facts
    .filter(fact => project(fact) === project(child))
    .map(fact => Number(fact.amount))
    .sort((left, right) => left - right)
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

/**
 * Identifier quoting differs per engine (double quotes, backticks). Remove the quote
 * characters and collapse whitespace so structural assertions stay portable.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/[`"]/g, '').replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Split the emitted SQL into the pre-aggregation CTE body and everything outside it,
 * so predicate ownership and table scope can be asserted separately.
 */
function splitPreAggregation(sql: string): { cte: string; outer: string } {
  const normalized = normalizeSql(sql)
  const openIndex = normalized.indexOf(' as (')
  if (openIndex === -1) {
    throw new Error('emitted SQL has no pre-aggregation CTE')
  }
  let depth = 0
  let closeIndex = -1
  for (let index = openIndex + 4; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
      if (depth === 0) {
        closeIndex = index
        break
      }
    }
  }
  if (closeIndex === -1) {
    throw new Error('emitted SQL has an unbalanced pre-aggregation CTE')
  }
  return {
    cte: normalized.slice(openIndex + 5, closeIndex),
    outer: normalized.slice(0, openIndex) + normalized.slice(closeIndex + 1)
  }
}

/**
 * The fact table lives only inside the pre-aggregation CTE, so the outer query must
 * read it through the CTE alias and never reference the table itself (R10).
 */
function expectNoOuterFactTableReference(sql: string): void {
  const { outer } = splitPreAggregation(sql)
  expect(outer).not.toContain('root_invariant_facts')
}

/**
 * Equal selected values must form one final group, so no unselected child identity or
 * correlation column may remain in the outer GROUP BY to split them (R4).
 */
function expectNoPrivateChildIdentityInOuterGroupBy(sql: string): void {
  const { outer } = splitPreAggregation(sql)
  const groupByIndex = outer.lastIndexOf('group by')
  expect(groupByIndex).toBeGreaterThan(-1)
  const groupBy = outer.slice(groupByIndex)
  expect(groupBy).not.toContain('root_invariant_children.id')
  expect(groupBy).not.toContain('root_invariant_children.identity_key')
  expect(groupBy).not.toContain('root_invariant_children.simple_correlation_key')
}

const expectedChildRows = [
  { 'A.name': 'a1', 'B.name': 'b1', 'C.count': 3, 'C.amountSum': 6 },
  { 'A.name': 'a1', 'B.name': 'b2', 'C.count': 2, 'C.amountSum': 9 },
  { 'A.name': 'a1', 'B.name': 'b3', 'C.count': null, 'C.amountSum': null }
]

const expectedChildIdentityFilterRows = [
  { 'A.name': 'a1', 'B.name': 'b1', 'C.count': 3, 'C.amountSum': 6 },
  { 'A.name': 'a1', 'B.name': 'b3', 'C.count': null, 'C.amountSum': null }
]

const expectedFactFilterRows = [
  { 'A.name': 'a1', 'B.name': 'b1', 'C.count': null, 'C.amountSum': null },
  { 'A.name': 'a1', 'B.name': 'b2', 'C.count': 2, 'C.amountSum': 9 },
  { 'A.name': 'a1', 'B.name': 'b3', 'C.count': null, 'C.amountSum': null }
]

const expectedEqualSelectedValueRows = [
  { 'A.name': 'a1', 'B.name': 'shared', 'C.count': 5, 'C.amountSum': 15 }
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

    const expectedTotals = [...expectedOrganisationCounts.values()]
    expect(parents).toHaveLength(expectedTotals.reduce((total, counts) => total + counts.parents, 0))
    expect(children).toHaveLength(expectedTotals.reduce((total, counts) => total + counts.children, 0))
    expect(facts).toHaveLength(expectedTotals.reduce((total, counts) => total + counts.facts, 0))

    const organisationIds = new Set([
      ...parents.map((row: any) => row.organisationId),
      ...children.map((row: any) => row.organisationId),
      ...facts.map((row: any) => row.organisationId)
    ])
    expect([...organisationIds].sort((left, right) => left - right)).toEqual([
      ...expectedOrganisationCounts.keys()
    ])

    for (const [organisationId, counts] of expectedOrganisationCounts) {
      const organisationParents = parents.filter((row: any) => row.organisationId === organisationId)
      const organisationChildren = children.filter((row: any) => row.organisationId === organisationId)
      const organisationFacts = facts.filter((row: any) => row.organisationId === organisationId)

      expect(organisationParents).toHaveLength(counts.parents)
      expect(organisationChildren).toHaveLength(counts.children)
      expect(organisationFacts).toHaveLength(counts.facts)
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

      const compositeCorrelationPairs = new Set(
        organisationChildren.map((row: any) => compositeKey(row))
      )
      expect(organisationFacts.every((row: any) => compositeCorrelationPairs.has(compositeKey(row)))).toBe(true)
    }
  })

  test('the composite-collision namespace makes either single key component correlate a wrong child', async () => {
    const children = (await db.select().from(tables.rootInvariantChildren))
      .filter((row: any) => row.organisationId === compositeCollisionOrganisationId)
    const facts = (await db.select().from(tables.rootInvariantFacts))
      .filter((row: any) => row.organisationId === compositeCollisionOrganisationId)

    // Correlating on the complete pair gives the expected 3/6, 2/9 and zero-fact split.
    expect(children.map((child: any) => correlatedAmounts(facts, child, compositeKey))).toEqual([
      [1, 2, 3],
      [4, 5],
      []
    ])

    // Either component alone associates facts with a child that does not own them.
    expect(children.map((child: any) => correlatedAmounts(facts, child, row => row.compositeCorrelationKeyA))).toEqual([
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5],
      []
    ])
    expect(children.map((child: any) => correlatedAmounts(facts, child, row => row.compositeCorrelationKeyB))).toEqual([
      [1, 2, 3],
      [4, 5],
      [1, 2, 3]
    ])
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

  test('a non-visible parent identity filter keeps every child group under the parent root', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum'],
      filters: [{ member: 'A.identityKey', operator: 'equals', values: ['parent-1'] }]
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('A')

    const dryRun = await semanticLayer.dryRun(query, securityContext)
    const { cte, outer } = splitPreAggregation(dryRun.sql)

    // The parent predicate is owned by the outer query, and the child stays outer-left-joined.
    expect(outer).toContain('root_invariant_parents.identity_key =')
    expect(outer).toContain('left join root_invariant_children')
    expect(cte).not.toContain('root_invariant_children')
    expectNoOuterFactTableReference(dryRun.sql)
    expect(dryRun.params).toContain(baselineOrganisationId)
    expect(dryRun.params).not.toContain(foreignOrganisationId)

    const result = await semanticLayer.execute(query, securityContext)
    expect(sortRows(result.data)).toEqual(expectedChildRows)
  })

  test('a non-visible parent identity filter keeps every child group under the child root', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name', 'B.id'],
      measures: ['C.count', 'C.amountSum'],
      filters: [{ member: 'A.identityKey', operator: 'equals', values: ['parent-1'] }]
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const dryRun = await semanticLayer.dryRun(query, securityContext)
    const { outer } = splitPreAggregation(dryRun.sql)

    expect(outer).toContain('root_invariant_parents.identity_key =')
    expectNoOuterFactTableReference(dryRun.sql)
    expect(dryRun.params).not.toContain(foreignOrganisationId)

    const result = await semanticLayer.execute(query, securityContext)
    expect(withoutChildId(result.data)).toEqual(expectedChildRows)
  })

  test('a non-visible child identity filter excludes that child and its facts under the parent root', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum'],
      filters: [{ member: 'B.identityKey', operator: 'notEquals', values: ['child-2'] }]
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('A')

    const dryRun = await semanticLayer.dryRun(query, securityContext)
    const { cte, outer } = splitPreAggregation(dryRun.sql)

    // The child predicate is owned by the outer query, which keeps every eligible child
    // in the outer left join; the CTE only restricts fact rows.
    expect(outer).toContain('root_invariant_children.identity_key')
    expect(outer).toContain('left join root_invariant_children')
    expect(cte).toContain('root_invariant_facts')
    expectNoOuterFactTableReference(dryRun.sql)

    const result = await semanticLayer.execute(query, securityContext)
    expect(sortRows(result.data)).toEqual(expectedChildIdentityFilterRows)
  })

  test('a non-visible child identity filter excludes that child and its facts under the child root', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name', 'B.id'],
      measures: ['C.count', 'C.amountSum'],
      filters: [{ member: 'B.identityKey', operator: 'notEquals', values: ['child-2'] }]
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const dryRun = await semanticLayer.dryRun(query, securityContext)
    const { outer } = splitPreAggregation(dryRun.sql)

    expect(outer).toContain('root_invariant_children.identity_key')
    expectNoOuterFactTableReference(dryRun.sql)

    const result = await semanticLayer.execute(query, securityContext)
    expect(withoutChildId(result.data)).toEqual(expectedChildIdentityFilterRows)
  })

  test('a non-visible fact filter stays inside the CTE and keeps every child under the parent root', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum'],
      filters: [{ member: 'C.amount', operator: 'gt', values: [3] }]
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('A')

    const dryRun = await semanticLayer.dryRun(query, securityContext)
    const { cte, outer } = splitPreAggregation(dryRun.sql)

    // The fact predicate belongs to the pre-aggregation CTE and must not reach the
    // outer query, where it would collapse the child left join.
    expect(cte).toContain('root_invariant_facts.amount >')
    expect(outer).not.toContain('amount >')
    expect(outer).toContain('left join root_invariant_children')
    expectNoOuterFactTableReference(dryRun.sql)

    const result = await semanticLayer.execute(query, securityContext)
    expect(sortRows(result.data)).toEqual(expectedFactFilterRows)
  })

  test('a non-visible fact filter stays inside the CTE and keeps every child under the child root', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name', 'B.id'],
      measures: ['C.count', 'C.amountSum'],
      filters: [{ member: 'C.amount', operator: 'gt', values: [3] }]
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const dryRun = await semanticLayer.dryRun(query, securityContext)
    const { cte, outer } = splitPreAggregation(dryRun.sql)

    expect(cte).toContain('root_invariant_facts.amount >')
    expect(outer).not.toContain('amount >')
    expectNoOuterFactTableReference(dryRun.sql)

    const result = await semanticLayer.execute(query, securityContext)
    expect(withoutChildId(result.data)).toEqual(expectedFactFilterRows)
  })

  test('a composite child-to-fact key correlates every component under the parent root', async () => {
    const compositeSemanticLayer = createSemanticLayer(
      databaseExecutor,
      createRootInvariantCubes(tables, 'A', { childToFactCorrelation: 'composite' })
    )
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: compositeCollisionOrganisationId }

    const analysis = compositeSemanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('A')

    const dryRun = await compositeSemanticLayer.dryRun(query, securityContext)
    const { cte } = splitPreAggregation(dryRun.sql)

    // Both components must group the CTE, or a colliding component alone would
    // associate facts with the wrong child.
    expect(cte).toContain('composite_correlation_key_a')
    expect(cte).toContain('composite_correlation_key_b')
    expectNoOuterFactTableReference(dryRun.sql)
    expect(dryRun.params).toContain(compositeCollisionOrganisationId)
    expect(dryRun.params).not.toContain(foreignOrganisationId)

    const result = await compositeSemanticLayer.execute(query, securityContext)
    expect(sortRows(result.data)).toEqual(expectedChildRows)
  })

  test('a composite child-to-fact key correlates every component under the child root', async () => {
    const compositeSemanticLayer = createSemanticLayer(
      databaseExecutor,
      createRootInvariantCubes(tables, 'A', { childToFactCorrelation: 'composite' })
    )
    const parentRootedQuery: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const childRootedQuery: SemanticQuery = {
      dimensions: ['A.name', 'B.name', 'B.id'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: compositeCollisionOrganisationId }

    const analysis = compositeSemanticLayer.analyzeQuery(childRootedQuery, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const dryRun = await compositeSemanticLayer.dryRun(childRootedQuery, securityContext)
    const { cte } = splitPreAggregation(dryRun.sql)

    expect(cte).toContain('composite_correlation_key_a')
    expect(cte).toContain('composite_correlation_key_b')
    expectNoOuterFactTableReference(dryRun.sql)
    expect(dryRun.params).not.toContain(foreignOrganisationId)

    const childRooted = await compositeSemanticLayer.execute(childRootedQuery, securityContext)
    const parentRooted = await compositeSemanticLayer.execute(parentRootedQuery, securityContext)

    expect(childRooted.data.every(row => row['B.id'] !== undefined)).toBe(true)
    expect(withoutChildId(childRooted.data)).toEqual(expectedChildRows)
    expect(withoutChildId(childRooted.data)).toEqual(sortRows(parentRooted.data))
  })

  test('a declared fact back-reference keeps child grain under the parent root', async () => {
    const backReferenceSemanticLayer = createSemanticLayer(
      databaseExecutor,
      createRootInvariantCubes(tables, 'A', { factDeclaresBackReferences: true })
    )
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = backReferenceSemanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('A')

    const dryRun = await backReferenceSemanticLayer.dryRun(query, securityContext)
    const { outer } = splitPreAggregation(dryRun.sql)

    // The declared back-reference must not route the child through the CTE: the child
    // stays outer-left-joined so the zero-fact child survives.
    expect(outer).toContain('left join root_invariant_children')
    expectNoOuterFactTableReference(dryRun.sql)
    expect(dryRun.params).toContain(baselineOrganisationId)
    expect(dryRun.params).not.toContain(foreignOrganisationId)

    const result = await backReferenceSemanticLayer.execute(query, securityContext)
    expect(sortRows(result.data)).toEqual(expectedChildRows)
  })

  test('a declared fact back-reference keeps child grain under the child root', async () => {
    const backReferenceSemanticLayer = createSemanticLayer(
      databaseExecutor,
      createRootInvariantCubes(tables, 'A', { factDeclaresBackReferences: true })
    )
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name', 'B.id'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: baselineOrganisationId }

    const analysis = backReferenceSemanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const dryRun = await backReferenceSemanticLayer.dryRun(query, securityContext)
    expectNoOuterFactTableReference(dryRun.sql)
    expect(dryRun.params).not.toContain(foreignOrganisationId)

    const result = await backReferenceSemanticLayer.execute(query, securityContext)

    // The declared back-reference must match the ordinary reverse-edge result, including
    // the retained zero-fact child.
    const reverseEdgeResult = await semanticLayer.execute(query, securityContext)
    expect(withoutChildId(result.data)).toEqual(expectedChildRows)
    expect(withoutChildId(result.data)).toEqual(withoutChildId(reverseEdgeResult.data))
  })

  test('equal selected child values form one group under the parent root', async () => {
    const query: SemanticQuery = {
      dimensions: ['A.name', 'B.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: equalSelectedValueOrganisationId }

    const analysis = semanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('A')

    const dryRun = await semanticLayer.dryRun(query, securityContext)
    expectNoOuterFactTableReference(dryRun.sql)
    expectNoPrivateChildIdentityInOuterGroupBy(dryRun.sql)

    const result = await semanticLayer.execute(query, securityContext)
    expect(sortRows(result.data)).toEqual(expectedEqualSelectedValueRows)
  })

  test('equal selected child values form one group under the renamed-parent child root', async () => {
    const renamedSemanticLayer = createSemanticLayer(
      databaseExecutor,
      createRootInvariantCubes(tables, 'Z')
    )
    const query: SemanticQuery = {
      dimensions: ['Z.name', 'B.name'],
      measures: ['C.count', 'C.amountSum']
    }
    const securityContext = { organisationId: equalSelectedValueOrganisationId }

    const analysis = renamedSemanticLayer.analyzeQuery(query, securityContext)
    expect(analysis.primaryCube.selectedCube).toBe('B')

    const dryRun = await renamedSemanticLayer.dryRun(query, securityContext)
    expectNoOuterFactTableReference(dryRun.sql)
    expectNoPrivateChildIdentityInOuterGroupBy(dryRun.sql)

    const result = await renamedSemanticLayer.execute(query, securityContext)
    const normalized = sortRows(result.data).map(row => ({
      'A.name': row['Z.name'],
      'B.name': row['B.name'],
      'C.count': row['C.count'],
      'C.amountSum': row['C.amountSum']
    }))

    expect(normalized).toEqual(expectedEqualSelectedValueRows)
  })
})
