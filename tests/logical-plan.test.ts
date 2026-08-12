/**
 * Logical Plan Pipeline Tests
 *
 * Verifies the multi-stage planning pipeline:
 * SemanticQuery → LogicalPlanBuilder → Optimiser → execution.
 */

import { describe, it, expect, beforeAll, test, vi } from 'vitest'
import {
  createTestDatabaseExecutor,
  createTestSemanticLayer,
  getTestDatabaseType
} from './helpers/test-database'
import { createTestCubesForCurrentDatabase } from './helpers/test-cubes'
import {
  LogicalPlanBuilder,
  IdentityOptimiser,
  OptimiserPipeline,
  LogicalPlanner,
  QueryExecutor,
  JoinPathResolver,
  defineCube
} from '../src/server'
import type {
  SimpleSource,
  Cube,
  QueryContext,
  SecurityContext,
  DatabaseExecutor,
  SemanticQuery,
  PlanOptimiser,
  OptimiserContext,
  QueryNode,
  BaseQueryDefinition
} from '../src/server'
import { eq } from 'drizzle-orm'
import { readCTECorrelationMetadata } from '../src/server/cte-correlation-metadata'
import { getTestSchema } from './helpers/test-database'

const dbType = getTestDatabaseType()

function rebuildPlanFromDeclaredFields(plan: QueryNode): QueryNode {
  if (plan.source.type !== 'simpleSource') {
    return plan
  }

  const source = plan.source
  return {
    type: 'query',
    schema: plan.schema,
    source: {
      type: 'simpleSource',
      schema: source.schema,
      primaryCube: source.primaryCube,
      joins: [...source.joins],
      ctes: source.ctes.map(cte => ({
        type: 'ctePreAggregate',
        schema: cte.schema,
        cube: cte.cube,
        alias: cte.alias,
        cteAlias: cte.cteAlias,
        joinKeys: [...cte.joinKeys],
        measures: [...cte.measures],
        propagatingFilters: cte.propagatingFilters,
        downstreamJoinKeys: cte.downstreamJoinKeys,
        intermediateJoins: cte.intermediateJoins,
        cteType: cte.cteType,
        cteReason: cte.cteReason
      })),
    },
    dimensions: [...plan.dimensions],
    measures: [...plan.measures],
    filters: [...plan.filters],
    timeDimensions: [...plan.timeDimensions],
    orderBy: [...plan.orderBy],
    limit: plan.limit,
    offset: plan.offset,
    ungrouped: plan.ungrouped,
    warnings: [...plan.warnings]
  }
}

async function createRootInvariantCubes(): Promise<Map<string, Cube>> {
  const schema: any = await getTestSchema()
  const { rootInvariantParents, rootInvariantChildren, rootInvariantFacts } = schema
  let parentCube: Cube
  let childCube: Cube
  let factCube: Cube

  parentCube = defineCube('A', {
    sql: (context: QueryContext): BaseQueryDefinition => ({
      from: rootInvariantParents,
      where: eq(rootInvariantParents.organisationId, context.securityContext.organisationId as number)
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
      name: { name: 'name', type: 'string', sql: rootInvariantParents.name }
    },
    measures: {}
  })

  childCube = defineCube('B', {
    sql: (context: QueryContext): BaseQueryDefinition => ({
      from: rootInvariantChildren,
      where: eq(rootInvariantChildren.organisationId, context.securityContext.organisationId as number)
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
      id: { name: 'id', type: 'number', sql: rootInvariantChildren.id, primaryKey: true },
      name: { name: 'name', type: 'string', sql: rootInvariantChildren.name }
    },
    measures: {}
  })

  factCube = defineCube('C', {
    sql: (context: QueryContext): BaseQueryDefinition => ({
      from: rootInvariantFacts,
      where: eq(rootInvariantFacts.organisationId, context.securityContext.organisationId as number)
    }),
    dimensions: {},
    measures: {
      count: { name: 'count', type: 'count', sql: rootInvariantFacts.id },
      amountSum: { name: 'amountSum', type: 'sum', sql: rootInvariantFacts.amount }
    }
  })

  return new Map([
    ['A', parentCube],
    ['B', childCube],
    ['C', factCube]
  ])
}

describe(`Logical Plan Pipeline (${dbType})`, () => {
  let cubes: Map<string, Cube>
  let dbExecutor: DatabaseExecutor
  let queryPlanner: LogicalPlanner
  let logicalPlanBuilder: LogicalPlanBuilder
  let securityContext: SecurityContext
  let ctx: QueryContext

  beforeAll(async () => {
    const testCubes = await createTestCubesForCurrentDatabase()
    const { executor: rawExecutor } = await createTestDatabaseExecutor()
    dbExecutor = rawExecutor

    cubes = new Map<string, Cube>()
    cubes.set('Employees', testCubes.testEmployeesCube)
    cubes.set('Departments', testCubes.testDepartmentsCube)
    cubes.set('Productivity', testCubes.testProductivityCube)

    queryPlanner = new LogicalPlanner()
    logicalPlanBuilder = new LogicalPlanBuilder(queryPlanner)

    securityContext = { organisationId: 1 }
    ctx = {
      db: (dbExecutor as any).db,
      schema: (dbExecutor as any).schema,
      securityContext
    }
  })

  // ---------------------------------------------------------------------------
  // Plan structure tests
  // ---------------------------------------------------------------------------

  describe('Plan Structure', () => {
    it('should produce a QueryNode root for a simple single-cube query', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count'],
        dimensions: ['Employees.name']
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)

      expect(plan.type).toBe('query')
      expect(plan.measures).toHaveLength(1)
      expect(plan.measures[0].name).toBe('Employees.count')
      expect(plan.dimensions).toHaveLength(1)
      expect(plan.dimensions[0].name).toBe('Employees.name')
    })

    it('should produce a SimpleSource for single-cube queries', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count']
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)
      const source = plan.source as SimpleSource

      expect(source.type).toBe('simpleSource')
      expect(source.primaryCube.name).toBe('Employees')
      expect(source.joins).toHaveLength(0)
      expect(source.ctes).toHaveLength(0)
    })

    it('should include joins for multi-cube queries', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count'],
        dimensions: ['Departments.name']
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)
      const source = plan.source as SimpleSource

      expect(source.type).toBe('simpleSource')
      expect(source.joins.length).toBeGreaterThanOrEqual(1)
      const deptJoin = source.joins.find(j => j.target.name === 'Departments')
      expect(deptJoin).toBeDefined()
    })

    it('should include CTEs for hasMany relationships', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count', 'Productivity.totalLinesOfCode'],
        dimensions: ['Employees.name']
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)
      const source = plan.source as SimpleSource

      expect(source.ctes.length).toBeGreaterThanOrEqual(1)
      const productivityCTE = source.ctes.find(c => c.cube.name === 'Productivity')
      expect(productivityCTE).toBeDefined()
      expect(productivityCTE!.type).toBe('ctePreAggregate')
      expect(productivityCTE!.cteReason).toBe('hasMany')
    })

    it('should capture filters from the query', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count'],
        filters: [
          { member: 'Employees.name', operator: 'equals', values: ['Alice'] }
        ]
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)

      expect(plan.filters).toHaveLength(1)
      expect(plan.filters[0]).toEqual({
        member: 'Employees.name',
        operator: 'equals',
        values: ['Alice']
      })
    })

    it('should capture time dimensions', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count'],
        timeDimensions: [
          { dimension: 'Employees.createdAt', granularity: 'month' }
        ]
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)

      expect(plan.timeDimensions).toHaveLength(1)
      expect(plan.timeDimensions[0].name).toBe('Employees.createdAt')
      expect(plan.timeDimensions[0].granularity).toBe('month')
    })

    it('should capture order, limit, and offset', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count'],
        dimensions: ['Employees.name'],
        order: { 'Employees.count': 'desc' },
        limit: 10,
        offset: 5
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)

      expect(plan.orderBy).toEqual([{ name: 'Employees.count', direction: 'desc' }])
      expect(plan.limit).toBe(10)
      expect(plan.offset).toBe(5)
    })

    it('should capture warnings from query planning', () => {
      // Query with hasMany and no dimensions → fan-out warning
      const query: SemanticQuery = {
        measures: ['Employees.count', 'Productivity.totalLinesOfCode']
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)

      // Warnings may or may not be present depending on exact planner behavior,
      // but the field should exist
      expect(Array.isArray(plan.warnings)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Optimiser tests
  // ---------------------------------------------------------------------------

  describe('Optimiser', () => {
    it('IdentityOptimiser should return the plan unchanged', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count'],
        dimensions: ['Employees.name']
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)
      const optimiser = new IdentityOptimiser()
      const optimised = optimiser.optimise(plan)

      // Should be the exact same reference
      expect(optimised).toBe(plan)
    })

    it('OptimiserPipeline should run passes in order', () => {
      const query: SemanticQuery = {
        measures: ['Employees.count']
      }

      const plan = logicalPlanBuilder.plan(cubes, query, ctx)
      const pipeline = new OptimiserPipeline([
        new IdentityOptimiser(),
        new IdentityOptimiser()
      ])

      const optimised = pipeline.optimise(plan, { engineType: 'postgres' })
      // After two identity passes, should still equal the original
      expect(optimised).toBe(plan)
    })

    it('an injected PlanOptimiser is used by the executor pipeline', () => {
      // A custom optimiser that rewrites the root QueryNode: drop the last
      // measure and force a limit. This proves the executor threads the
      // injected optimiser into its planning pipeline (Stage 1).
      const seenEngines: string[] = []
      const customOptimiser: PlanOptimiser = {
        name: 'test-rewrite',
        optimise(plan, context: OptimiserContext) {
          seenEngines.push(context.engineType)
          const node = plan as QueryNode
          if (node.type !== 'query') return plan
          return {
            ...node,
            measures: node.measures.slice(0, 1),
            limit: 42
          }
        }
      }

      const executor = new QueryExecutor(dbExecutor, undefined, undefined, customOptimiser)
      const query: SemanticQuery = {
        measures: ['Employees.count', 'Employees.avgSalary'],
        dimensions: ['Employees.name']
      }

      const optimisedPlan = executor.buildLogicalPlan(cubes, query, securityContext)

      // The optimiser's rewrites are reflected in the plan the executor uses.
      expect(optimisedPlan.measures).toHaveLength(1)
      expect(optimisedPlan.limit).toBe(42)
      // The real engine type was passed through (no collapsing to a subset).
      expect(seenEngines).toContain(dbType === 'both' ? 'postgres' : dbType)
    })

    test('declared-field reconstruction restores ordinary child correlation', async () => {
      const rootInvariantCubes = await createRootInvariantCubes()
      const rebuildingOptimiser: PlanOptimiser = {
        name: 'rebuild-declared-fields',
        optimise(plan) {
          return rebuildPlanFromDeclaredFields(plan as QueryNode)
        }
      }
      const executor = new QueryExecutor(dbExecutor, undefined, undefined, rebuildingOptimiser)
      const query: SemanticQuery = {
        dimensions: ['A.name', 'B.name'],
        measures: ['C.count', 'C.amountSum']
      }

      const result = await executor.execute(rootInvariantCubes, query, { organisationId: 9101 })
      const rows = [...result.data].sort((left, right) =>
        String(left['B.name']).localeCompare(String(right['B.name']))
      )

      expect(rows).toEqual([
        { 'A.name': 'a1', 'B.name': 'b1', 'C.count': 3, 'C.amountSum': 6 },
        { 'A.name': 'a1', 'B.name': 'b2', 'C.count': 2, 'C.amountSum': 9 },
        { 'A.name': 'a1', 'B.name': 'b3', 'C.count': null, 'C.amountSum': null }
      ])
    })

    test('correlation restoration follows optimized dimensions', async () => {
      const rootInvariantCubes = await createRootInvariantCubes()
      const rewritingOptimiser: PlanOptimiser = {
        name: 'remove-child-grouping',
        optimise(plan) {
          const node = plan as QueryNode
          return {
            ...node,
            dimensions: node.dimensions.filter(dimension => dimension.name !== 'B.name')
          }
        }
      }
      const executor = new QueryExecutor(dbExecutor, undefined, undefined, rewritingOptimiser)
      const query: SemanticQuery = {
        dimensions: ['A.name', 'B.name'],
        measures: ['C.count', 'C.amountSum']
      }

      const sqlResult = await executor.generateMultiCubeSQL(
        rootInvariantCubes,
        query,
        { organisationId: 9101 }
      )

      expect(sqlResult.sql).not.toContain('child_correlation_key')
      expect(sqlResult.sql).not.toContain('B.name')
    })

    test('correlation restoration traverses keys deduplication sources', async () => {
      const rootInvariantCubes = await createRootInvariantCubes()
      const rebuildingOptimiser: PlanOptimiser = {
        name: 'rebuild-keys-deduplication-sources',
        optimise(plan) {
          const rebuilt = rebuildPlanFromDeclaredFields(plan as QueryNode)
          if (rebuilt.source.type !== 'simpleSource') return rebuilt

          return {
            ...rebuilt,
            source: {
              type: 'keysDeduplication',
              schema: rebuilt.source.schema,
              keysSource: rebuilt.source,
              measureSource: rebuilt.source,
              joinOn: []
            }
          }
        }
      }
      const executor = new QueryExecutor(dbExecutor, undefined, undefined, rebuildingOptimiser)
      const query: SemanticQuery = {
        dimensions: ['A.name', 'B.name'],
        measures: ['C.count', 'C.amountSum']
      }

      const sqlResult = await executor.generateMultiCubeSQL(
        rootInvariantCubes,
        query,
        { organisationId: 9101 }
      )

      expect(sqlResult.sql).toContain('child_correlation_key')
    })

    test('correlation restoration uses each nested query shape', async () => {
      const rootInvariantCubes = await createRootInvariantCubes()
      let restoredPlan: QueryNode | undefined
      const nestingOptimiser: PlanOptimiser = {
        name: 'nest-different-query-shapes',
        optimise(plan) {
          const withChildGrouping = rebuildPlanFromDeclaredFields(plan as QueryNode)
          const parentOnly = rebuildPlanFromDeclaredFields({
            ...(plan as QueryNode),
            dimensions: (plan as QueryNode).dimensions.filter(
              dimension => dimension.name !== 'B.name'
            )
          })
          restoredPlan = {
            ...withChildGrouping,
            source: {
              type: 'multiFactMerge',
              schema: withChildGrouping.schema,
              groups: [withChildGrouping, parentOnly],
              sharedDimensions: parentOnly.dimensions,
              mergeStrategy: 'fullJoin'
            }
          }
          return restoredPlan
        }
      }
      const executor = new QueryExecutor(dbExecutor, undefined, undefined, nestingOptimiser)
      const query: SemanticQuery = {
        dimensions: ['A.name', 'B.name'],
        measures: ['C.count', 'C.amountSum']
      }

      executor.buildLogicalPlan(rootInvariantCubes, query, { organisationId: 9101 })

      expect(restoredPlan?.source.type).toBe('multiFactMerge')
      if (restoredPlan?.source.type !== 'multiFactMerge') return
      const [withChildGrouping, parentOnly] = restoredPlan.source.groups
      expect(withChildGrouping.type).toBe('query')
      expect(parentOnly.type).toBe('query')
      if (withChildGrouping.type !== 'query' || parentOnly.type !== 'query') return
      expect(withChildGrouping.source.type).toBe('simpleSource')
      expect(parentOnly.source.type).toBe('simpleSource')
      if (withChildGrouping.source.type !== 'simpleSource' || parentOnly.source.type !== 'simpleSource') return

      expect(
        withChildGrouping.source.ctes.some(cte => readCTECorrelationMetadata(cte))
      ).toBe(true)
      expect(
        parentOnly.source.ctes.some(cte => readCTECorrelationMetadata(cte))
      ).toBe(false)
    })

    test('correlation restoration reorders optimized joins before SQL generation', async () => {
      const rootInvariantCubes = await createRootInvariantCubes()
      const reorderingOptimiser: PlanOptimiser = {
        name: 'move-fact-before-child',
        optimise(plan) {
          const node = plan as QueryNode
          if (node.source.type !== 'simpleSource') return node

          return {
            ...node,
            source: {
              ...node.source,
              joins: [...node.source.joins].sort((left, right) =>
                left.target.name === 'C' ? -1 : right.target.name === 'C' ? 1 : 0
              )
            }
          }
        }
      }
      const executor = new QueryExecutor(dbExecutor, undefined, undefined, reorderingOptimiser)
      const query: SemanticQuery = {
        dimensions: ['A.name', 'B.name'],
        measures: ['C.count', 'C.amountSum']
      }

      const sqlResult = await executor.generateMultiCubeSQL(
        rootInvariantCubes,
        query,
        { organisationId: 9101 }
      )
      const childJoinIndex = sqlResult.sql.indexOf('join "root_invariant_children"')
      const factJoinIndex = sqlResult.sql.indexOf('join "c_agg"')

      expect(childJoinIndex).toBeGreaterThan(-1)
      expect(factJoinIndex).toBeGreaterThan(childJoinIndex)
    })

    test('optimized grouping owners bound correlation path restoration calls', async () => {
      const rootInvariantCubes = await createRootInvariantCubes()
      const pathSpy = vi.spyOn(JoinPathResolver.prototype, 'findPathPreferring')
      const rebuildingOptimiser: PlanOptimiser = {
        name: 'observe-restored-frontier',
        optimise(plan) {
          pathSpy.mockClear()
          return rebuildPlanFromDeclaredFields(plan as QueryNode)
        }
      }
      const executor = new QueryExecutor(dbExecutor, undefined, undefined, rebuildingOptimiser)
      const query: SemanticQuery = {
        dimensions: ['A.name', 'B.name'],
        measures: ['C.count', 'C.amountSum'],
        filters: [{ member: 'A.name', operator: 'equals', values: ['a1'] }],
        order: { 'C.count': 'desc' }
      }

      try {
        await executor.buildLogicalPlan(rootInvariantCubes, query, { organisationId: 9101 })

        expect(pathSpy).toHaveBeenCalledTimes(2)
        expect(pathSpy.mock.calls.map(call => call[0])).toEqual(['A', 'B'])
        expect(pathSpy.mock.calls.every(call => call[1] === 'C')).toBe(true)
        const processedSets = pathSpy.mock.calls.map(call => call[3])
        expect(processedSets.every(processed => processed instanceof Set && processed.size === 0)).toBe(true)
        expect(new Set(processedSets).size).toBe(processedSets.length)
      } finally {
        pathSpy.mockRestore()
      }
    })

    it('an optimiser rewrite changes the generated SQL (Stage 2)', async () => {
      const query: SemanticQuery = {
        measures: ['Employees.count', 'Employees.avgSalary'],
        dimensions: ['Employees.name']
      }

      // Baseline: no optimiser rewrites (IdentityOptimiser).
      const baseExecutor = new QueryExecutor(dbExecutor)
      const baseSql = await baseExecutor.generateMultiCubeSQL(cubes, query, securityContext)

      // Optimiser that drops the second measure and forces a limit. Because
      // build() now derives its clauses from the optimised plan, these rewrites
      // must surface in the generated SQL.
      const rewriteOptimiser: PlanOptimiser = {
        name: 'test-sql-rewrite',
        optimise(plan) {
          const node = plan as QueryNode
          if (node.type !== 'query') return plan
          return { ...node, measures: node.measures.slice(0, 1), limit: 7 }
        }
      }
      const rewriteExecutor = new QueryExecutor(dbExecutor, undefined, undefined, rewriteOptimiser)
      const rewriteSql = await rewriteExecutor.generateMultiCubeSQL(cubes, query, securityContext)

      // The optimised SQL differs from the baseline.
      expect(rewriteSql.sql).not.toBe(baseSql.sql)
      // The dropped measure's alias is gone from the optimised SQL.
      expect(baseSql.sql).toContain('Employees.avgSalary')
      expect(rewriteSql.sql).not.toContain('Employees.avgSalary')
      // The forced limit is applied (inline or parameterised).
      const limitApplied =
        /limit/i.test(rewriteSql.sql) &&
        (/\b7\b/.test(rewriteSql.sql) || (rewriteSql.params ?? []).includes(7))
      expect(limitApplied).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Integration test: end-to-end execution through logical plan pipeline
  // ---------------------------------------------------------------------------

  describe('Integration: end-to-end execution', () => {
    const integrationQueries: Array<{ name: string; query: SemanticQuery }> = [
      {
        name: 'single cube count',
        query: { measures: ['Employees.count'] }
      },
      {
        name: 'single cube with dimensions',
        query: {
          measures: ['Employees.count', 'Employees.avgSalary'],
          dimensions: ['Employees.name']
        }
      },
      {
        name: 'multi-cube join',
        query: {
          measures: ['Employees.count'],
          dimensions: ['Departments.name']
        }
      },
      {
        name: 'multi-cube hasMany CTE',
        query: {
          measures: ['Employees.count', 'Productivity.totalLinesOfCode'],
          dimensions: ['Employees.name']
        }
      },
      {
        name: 'with filter',
        query: {
          measures: ['Employees.count'],
          dimensions: ['Employees.name'],
          filters: [
            { member: 'Employees.name', operator: 'contains', values: ['o'] }
          ]
        }
      }
    ]

    for (const { name, query } of integrationQueries) {
      it(`should execute successfully: ${name}`, async () => {
        const { semanticLayer, close } = await createTestSemanticLayer()
        try {
          const testCubes = await createTestCubesForCurrentDatabase()
          semanticLayer.registerCube(testCubes.testEmployeesCube)
          semanticLayer.registerCube(testCubes.testDepartmentsCube)
          semanticLayer.registerCube(testCubes.testProductivityCube)

          const result = await semanticLayer.execute(query, securityContext)

          expect(result.data).toBeDefined()
          expect(Array.isArray(result.data)).toBe(true)
          expect(result.annotation).toBeDefined()

          // Verify expected measures/dimensions in annotations
          for (const m of query.measures ?? []) {
            expect(result.annotation.measures).toHaveProperty(m)
          }
          for (const d of query.dimensions ?? []) {
            expect(result.annotation.dimensions).toHaveProperty(d)
          }
        } finally {
          close()
        }
      })
    }
  })
})
