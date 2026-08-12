---
title: Root-Invariant Measure Grain - Plan
type: fix
date: 2026-08-12
topic: root-invariant-measure-grain
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Root-Invariant Measure Grain - Plan

## Goal Capsule

- **Objective:** Make measures compiled through the single-fact pre-aggregation path follow the grouping and filtering semantics expressed by the query and semantic graph. For stable grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation, the measure must not change merely because the planner picks a different root or a cube is renamed. Route changes must also preserve valid SQL for selected intermediate dimensions and must not create outer references to tables that exist only inside the pre-aggregation CTE.
- **Product authority:** Requirements below are settled by the operator from the completed diagnosis. Root scoring, chart/client behavior, multi-fact aggregation, keys-deduplication, and the query language itself are not active scope.
- **Open blockers:** None. The empty-measure convention for a retained child row is settled: `null`.

---

## Product Contract

### Summary

A measure compiled through the single-fact pre-aggregation path must aggregate at the grouping grain expressed by the query. When a parent-child-fact graph correlates facts to the child, a query grouped by the parent and child returns one aggregate per selected child grouping value. For stable grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation, the aggregate is unchanged when the planner selects a different root. Child rows with no matching facts stay visible. No public API or root-scoring rule changes.

### Problem Frame

The library can bind a single-fact pre-aggregation CTE to the root cube alone. When a query also groups by a cube that sits between the root and fact on a valid relationship path, that cube can join on a separate branch and never enter the pre-aggregation key. The root-level aggregate then repeats on every child row.

The planner chooses a root by dimension count, then uses `localeCompare` on the cube name for a tie. The same graph and data can therefore return a correct or inflated result after a cube rename when the compared queries preserve grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation. Supported filters can expose related defects when their predicates interact with the aggregate or a child left join.

The common failure is silent: a plausible parent total repeats per child row. A related shape emits invalid SQL when the planner routes an outer join through a fact table that exists only inside the pre-aggregation CTE.

### Key Decisions

- Fix grain derivation, not root scoring. Once results are invariant for stable grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation, root choice returns to being a planning and performance concern. (session-settled: user-directed — chosen over a grain-aware root scorer because changing the root moves the FROM cube for many existing queries and does not remove name dependence.) Governs R1, R2, R3, R12.
- "Correct" means the final grouping partitions created by the selected grouping expressions. A pre-aggregation CTE may use unselected identity or correlation keys when safe correlation requires them. The outer query must recombine partial aggregates into exactly the selected grouping partitions: equal selected values form one final SQL group, and an unselected key must not remain in the outer `GROUP BY` merely to separate them. A filter may change the matching rows, but it must not change an aggregate through an unrelated root or route side effect when grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation otherwise stay fixed. (session-settled: user-directed.) Governs R1, R3, R4, R6.
- This contract covers `count` and additive `sum` measures when one fact cube supplies all selected measures and the planner creates one aggregate CTE to prevent fan-out across a multi-cube grouped query. It does not cover other aggregate classes, multi-fact aggregation, keys-deduplication, calculated-measure recomposition, or ungrouped-query behavior. Governs R1 through R8.
- The child-to-fact correlation used for an invariance comparison must stay semantically the same. A graph in which competing valid paths encode different correlations is ambiguous and outside this work; this contract does not choose among conflicting semantic paths. Governs R1, R3, R4.
- Zero-fact child rows become visible where they are silently dropped today. This visible result-set change is accepted because the query uses left-join semantics. A child remains eligible after parent and child filters; if fact-side filters leave it with no matching facts, it remains with a `null` measure. (session-settled: user-directed.) Governs R5.
- A retained child row with no fact rows carries `null` on this single-fact pre-aggregation path, matching the equivalent child-rooted query and keeping the compatibility surface small. Empty measures are not normalized to zero here; the coalesce-to-zero convention on the multi-fact and keys-dedup paths is separate work. (session-settled: user-directed.) Governs R5.
- No public API change. `preferredFor` stays the documented route hint and is not extended. (session-settled: user-directed.) Governs R11.

### Definitions

- **Grouping partitions:** Sets of rows that have equal values for all selected dimension and time-dimension expressions. Visibility in a client does not change whether a member groups SQL rows.
- **Non-visible filter:** A filter whose member need not be selected or emitted in the query result. For a comparison, it is one supported simple top-level conjunctive filter on one query member and operator. Its stated row-selection effect is the only semantic difference between the baseline and filtered query. After that effect, the comparison keeps the relevant grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation fixed. Nested filter groups and mixed-cube `AND`/`OR` filter-group semantics are outside this work.
- **Child-to-fact correlation:** A forward or reverse relationship path that maps each fact row to the child grouping represented by the query. Comparisons under R1 through R4 keep this mapping unchanged even if the planner traverses the graph from another root.

### Requirements

**Invariance**

- R1. For the same grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation, an affected measure's value does not change when the planner selects a different root cube.
- R2. For the same grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation, an affected measure's value does not change when a root-candidate cube is renamed and that rename reverses the alphabetical tie-break between the candidate roots.
- R3. A supported simple top-level conjunctive non-visible filter has only its stated row-selection effect. It must not collapse retained child rows or change aggregates through unrelated root or route side effects. AE8 is the complete mandatory representative regression set. R3 also governs equivalent supported simple top-level conjunctive filters encountered in the changed path; it does not require an open-ended fixture matrix or a physical route change. Nested and mixed-cube Boolean filter groups are outside this work.

**Grain and retention**

- R4. When a query groups by a parent and child and the semantic graph supplies the same child-to-fact correlation in both compared plans, the affected measure aggregates by the selected child grouping expressions rather than repeating the parent total. Internal CTEs may use unselected identity or correlation keys when safe correlation requires them. The outer query must recombine partial aggregates into exactly the selected grouping partitions: equal selected child values form one final group, and no unselected child identity key may remain in the outer `GROUP BY` to split them.
- R5. Every child that remains after parent and child filters stays in the result under left-join semantics. If no fact rows match its correlation and fact-side filters, the affected measure is `null`.

**Preserved behavior**

- R6. A direct parent-to-fact query with no child grouping member returns the parent-level aggregate unchanged.
- R7. A query whose fact declares a back-reference to the child returns child-grain aggregates, retains eligible zero-fact children with `null`, and follows the same grouping rules as the equivalent reverse-edge declaration.
- R8. The affected pre-aggregation path can use the resolver's existing reverse edge to correlate a grouping cube with the fact without requiring the caller to declare the duplicate relationship in the opposite direction.

**SQL validity**

- R9. A selected dimension from an intermediate cube resolves to valid SQL when `preferredFor` selects a route that the pre-aggregation absorbs or otherwise represents internally.
- R10. Emitted SQL never references, from the outer query, a table that exists only inside a CTE.

**Surface and scope**

- R11. The public API is unchanged: no new query field, cube-definition field, configuration key, store, or planner subsystem.
- R12. Root selection keeps its dimension-count scoring and alphabetical tie-break.

**Verification coverage**

- R13. All 18 mandatory executions run on SQLite, PostgreSQL, and MySQL, the three engines that CI runs unconditionally. The same fixture and assertions apply on each engine. AE4 is a shared assertion on every applicable execution, not an execution itself. Cross-engine row comparisons use keyed row maps or deterministic sorting before they assert equal rows; database return order is not evidence of equality.
- R14. Diff review proves R11 by confirming that the change adds no exported query, cube-definition, or configuration type, store, or planner subsystem.
- R15. Existing focused root-selection tests continue to prove the dimension-count rule and alphabetical tie-break required by R12.

### Acceptance Examples

The fixture is a bidirectionally reachable parent-child-fact graph: parent `A` has many children `B` and facts `C`; child `B` belongs to `A` and has many `C`; fact `C` belongs to `A` and has no declared back-reference to `B` except where an example adds one. The resolver can traverse each non-junction relationship in reverse, so the named root candidates can reach the query cubes. One `A`; children `b1`, `b2`, `b3`; three fact rows under `b1`, two under `b2`, none under `b3`. Fact amounts are `1, 2, 3` under `b1` and `4, 5` under `b2`. The parent totals are count `5` and sum `15`; child totals are `b1 = count 3, sum 6`, `b2 = count 2, sum 9`. Root-change examples state expected dimension counts. All route evidence comes from the physical plan that emits the tested SQL. All result comparisons use keyed row maps or deterministic sorting before row equality is asserted.

- AE1. Correlated grain without a fact back-reference.
  - **Covers R4, R8, R10.**
  - **Given:** `C` declares no join to `B`; only `B hasMany C` supplies the child-to-fact correlation.
  - **When:** the query selects `A.name`, `B.name`, `C.count`, and `C.amountSum`.
  - **Then:** `b1` is count 3 and sum 6; `b2` is count 2 and sum 9. The query executes without an outer reference to the fact table.
  - **Mandatory variant — composite child-to-fact correlation key:** On the ordinary non-absorbed child-to-fact correlation path, replace the child-to-fact correlation with a two-part key. Each individual key part collides across child and fact rows, so either part alone associates at least one fact with the wrong child. The query and expected child totals stay the same. Both the parent-rooted execution and the child-rooted execution must group and correlate the CTE with the complete key and return the correct per-child facts. Composite-key support for absorbed intermediate routes is separate work because the current intermediate-connection representation is single-column.
- AE2. An extra child grouping member changes the root without changing the grouping partitions.
  - **Covers R1.**
  - **Given:** the AE1 graph, where each child name is unique. The baseline has one selected dimension on `A` and one on `B`, so both have score 1 and alphabetical order selects `A`. Adding `B.id` preserves grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation because each child name is unique.
  - **When:** the query adds visible `B.id`, giving `B` score 2 while `A` stays at 1; the emitted physical plan proves that `B` becomes root.
  - **Then:** after comparison by stable row keys, the rows and both measure values are identical to AE1 apart from the added `B.id` column.
- AE3. Renaming the parent changes the tie-break but not results.
  - **Covers R2.**
  - **Given:** the AE1 query keeps one selected dimension on the parent and one on `B`, so both candidates have score 1. The parent is renamed so it sorts after `B`. The rename preserves grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation.
  - **When:** the query uses the renamed parent's `name`, `B.name`, `C.count`, and `C.amountSum`; the emitted physical plan proves that the unchanged tie-break now selects `B`.
  - **Then:** after accounting for the renamed parent member key, the grouping partitions, selected dimension values, and measure values match AE1.
- AE4. A zero-fact child remains visible.
  - **Covers R5.**
  - **Given:** AE1, AE2, or AE3.
  - **When:** the result is read.
  - **Then:** `b3` is present with `null` for both affected measures.
- AE5. A direct parent-to-fact total is unchanged.
  - **Covers R6.**
  - **Given:** the AE1 graph.
  - **When:** the query selects `A.name`, `C.count`, and `C.amountSum` with no child grouping member.
  - **Then:** the single row is count 5 and sum 15.
- AE6. A preferred absorbed route keeps its selected intermediate dimension valid.
  - **Covers R1, R9.**
  - **Given:** the AE1 simple-key graph sets `preferredFor: ['C']` on the `A→B` relationship. The physical plan that emits the tested SQL proves the feasible `A→B→C` route and represents `B` inside the pre-aggregation.
  - **When:** the query selects `A.name`, `B.name`, `C.count`, and `C.amountSum`. It runs once with the parent root and once with the AE2 root-forcing `B.id` member and child root.
  - **Then:** the parent-rooted execution proves that the emitted SQL keeps `B.name` valid as required by R9. After `B.id` is removed for comparison, the paired child-rooted execution proves R1 with the preferred route present: both roots return the same selected-value groups and measures. In each execution, `b1` is count 3 and sum 6; `b2` is count 2 and sum 9; and `b3` is retained with null measures.
- AE7. A declared fact back-reference follows the durable child-grain rules.
  - **Covers R7.**
  - **Given:** `C` declares `belongsTo B` alongside `belongsTo A`.
  - **When:** the query selects `A.name`, `B.name`, `C.count`, and `C.amountSum`.
  - **Then:** after comparison by stable row keys, its grouping partitions, matching fact rows, row multiplicity, child-to-fact correlation, result rows, values, and null behavior match AE1 and AE4.
- AE8. Supported simple top-level conjunctive non-visible filters have only their stated row-selection effects.
  - **Covers R1, R3, R5.**
  - **Given:** three variants over AE1 use members that the query does not otherwise select or emit: (a) filter the parent identity member with `equals` and the fixture parent's identity value; (b) filter the child identity member with `notEquals` and `b2`'s identity value; and (c) filter `C.amount` with `gt` and value `3`. Each filter is one top-level conjunct. The selected result members remain only `A.name`, `B.name`, `C.count`, and `C.amountSum`, plus `B.id` solely in the root-forcing execution.
  - **When:** each variant runs once with the parent-rooted AE1 query and once with the child-rooted AE2 root-forcing `B.id` member. For each run, physical-plan evidence proves the selected root, aggregate grain, applicable predicate placement, and child left-join behavior. No variant requires a route change.
  - **Then:** both roots produce the same predicate effects, retained children, and measure values after `B.id` is removed for comparison. Variant (a) keeps eligible children `b1,b2,b3` and all five facts, so its keyed rows match AE1 with AE4's shared null-retention assertion. Variant (b) keeps eligible children `b1,b3`, so `b1` is count 3 and sum 6 and `b3` is null. Variant (c) keeps eligible children `b1,b2,b3`, with matching facts amount 4 and 5 under `b2`, so `b1` is null, `b2` is count 2 and sum 9, and `b3` is null. Variant (b) proves that an unselected child member can exclude a child and its facts without leaking those facts into a group selected by `B.name`. No fact predicate collapses the child left join, and no filter changes an aggregate beyond its stated row-selection effect.
- AE9. Equal selected child values form one SQL group under both roots.
  - **Covers R1, R2, R4.**
  - **Given:** two child rows have the same selected `B.name` value `"shared"`, different `B.id` values, and different facts. The first child has three facts with amounts `1, 2, 3`; the second has two facts with amounts `4, 5`. The baseline parent name sorts before `B`; the AE3 parent rename makes the root-candidate parent sort after `B` without changing selected values, facts, row multiplicity, or child-to-fact correlation.
  - **When:** the query selects only `A.name`, `B.name`, `C.count`, and `C.amountSum`; it does not select `B.id`. In each run, the parent root candidate has score 1 and `B` has score 1. The baseline alphabetical tie-break selects the parent; the AE3 rename changes only that tie-break and selects `B`. The physical plans prove both roots.
  - **Then:** under both roots, the SQL result has one `"shared"` group with count 5 and sum 15. After accounting for the renamed parent member key, both results have the same selected-value grouping and measures. Internal CTE grouping may contain an unselected identity or correlation key when safe correlation requires it. The outer grouping evidence contains no unselected child identity key that splits the equal selected values.

The mandatory matrix has 18 unique executions per engine:

1. AE1 parent-rooted, simple key.
2. AE2 child-rooted, simple key. This is also AE1's child-root proof; it is not a second query.
3. AE1 parent-rooted, composite correlation key.
4. AE1 child-rooted, composite correlation key with the AE2 root-forcing member.
5. AE3 renamed-parent child-rooted execution.
6. AE5 direct parent-to-fact execution.
7. AE6 parent-rooted preferred-route execution.
8. AE6 child-rooted preferred-route execution with the AE2 root-forcing member.
9. AE7 parent-rooted fact-back-reference execution.
10. AE7 child-rooted fact-back-reference execution with the AE2 root-forcing member.
11. AE8 parent-identity filter, parent-rooted.
12. AE8 parent-identity filter, child-rooted.
13. AE8 child-identity filter, parent-rooted.
14. AE8 child-identity filter, child-rooted.
15. AE8 fact-amount filter, parent-rooted.
16. AE8 fact-amount filter, child-rooted.
17. AE9 equal selected values, baseline parent-rooted tie-break.
18. AE9 equal selected values, renamed-parent child-rooted tie-break.

AE4 is a shared assertion on every execution that can retain a zero-fact child; it is not a separate query. AE8's six executions are the complete mandatory representative filter set. R3 governs equivalent supported simple top-level conjunctive filters encountered in the changed path without expanding this fixture matrix. Across all root variants, the matrix requires the same stated predicate effects, null retention, selected-value grouping, and measure values. AE1 through AE9 and their named variants are the complete mandatory regression matrix and maintainer gauntlet for this work.

### Proposed mechanism — not binding on planning

The diagnosis proposes one mechanism so planning can compare it with any smaller alternative. Nothing in this section is a requirement. Planning must satisfy R1 through R15 and the fixed AE1 through AE9 matrix.

Derive the pre-aggregation CTE's group-by keys from query-member cubes that carry the child-to-fact correlation, rather than from the root alone. Keep eligible child cubes in the root's left-join chain and correlate the CTE on the full key set. The downstream-key derivation in `src/server/logical-plan/cte-planner.ts` could consult the existing reverse index in `src/server/resolvers/join-path-resolver.ts` instead of only a cube's forward joins.

Two constraints apply to any mechanism:

- Routing the child only through the pre-aggregation drops zero-fact child rows and violates R5. The child must remain eligible through the left-join chain.
- The outer query must not use a route whose join expression references the fact table available only inside the CTE, as forbidden by R10.

### Scope Boundaries

- Root selection scoring, its dimension-count heuristic, and alphabetical tie-break stay unchanged. Rename invariance covers only a root-candidate cube rename that reverses the demonstrated tie-break while preserving grouping partitions, matching fact rows, row multiplicity, and child-to-fact correlation.
- AE8 is the complete mandatory representative filter set. R3 still governs equivalent supported simple top-level conjunctive filters encountered in the changed path. Nested and mixed-cube Boolean filter groups are separate work.
- Aggregate classes other than `count` and additive `sum`, multi-fact aggregation, keys-deduplication, calculated-measure recomposition, and global empty-measure normalization are separate work.
- Graphs whose competing valid paths encode different child-to-fact correlations are outside this contract; callers must provide an unambiguous semantic graph.
- Composite-key coverage applies to the ordinary non-absorbed child-to-fact correlation path in the AE1 composite variant. Composite-key support for absorbed intermediate routes is separate work because the current intermediate-connection representation is single-column. AE6 remains a simple-key pair and adds no composite execution.
- No new query expression for repeating a parent total per child row.
- No new public API, cube-definition field, configuration key, store, or planner subsystem.
- Client, chart, and dashboard code remain untouched; this is a server-side planning fix.
- DuckDB, Databend, and Snowflake are outside the required matrix for this work.
- Reconciliation of the user-facing plan-analysis trace with the built plan is separate work. Acceptance evidence must inspect the physical plan used to emit the tested SQL or an existing observation point proved to represent that same plan.
- SQL performance tuning and new latency targets are outside scope. The change must not add combinatorial enumeration across query members, candidate roots, and relationship paths. It may use the resolver's existing bounded path evaluation. The later implementation plan must name the exact observation point and proving command.

### Dependencies and Assumptions

- The diagnosis was proved on SQLite only. The defect is in query planning above the engine executors, so R13 tests rather than assumes engine independence.
- The silent repeated-total result and the invalid outer SQL reference share the affected planning path and both are covered.
- The resolver's existing reverse index can identify the diagnosed reverse edge; the implementation plan must verify this before relying on it.
- CI runs PostgreSQL, MySQL, and SQLite unconditionally.

### Outstanding Questions

None. Planning must not reopen the settled product decisions above. A newly discovered architecture fork returns to requirements review rather than being decided during implementation.

## Planning Contract

### Key Technical Decisions

- KTD1. Separate CTE root join keys from child-correlation keys. `PreAggregationCTEInfo.joinKeys` continues to describe how the outer root joins the CTE. Private correlation metadata is attached through a module-private symbol rather than declared on exported planner types. It exists only where the current planner, conversion, and CTE builder stages need extra child-to-fact grouping and join columns. This prevents private correlation keys from becoming public type fields or final selected-value grouping keys. Governs R1, R4, R5, R6, R11.
- KTD2. Derive correlation from each queried non-measure grouping cube, not from the selected root. On the scoped single-fact path, identify the one cube that owns all selected measures as the fact cube. Collect the distinct cube owners of selected dimensions and time dimensions, excluding the fact cube, and evaluate them in sorted cube-name order. For each grouping cube, call the existing `JoinPathResolver.findPathPreferring(groupingCube, factCube, analyzeCubeUsage(query), new Set())`. Remove a grouping cube from the correlation frontier when its selected path passes through another queried grouping cube before reaching the fact; the remaining fact-nearest grouping cubes define correlation. A frontier correlation identical to the existing root `joinKeys` adds no extra metadata, which preserves direct parent-only queries. Orient every ordinary correlation component with `InternalJoinPathStep.reversed`, and preserve the complete `joinDef.on[]` array as one atomic correlation set. Conflicting retained correlations remain outside scope. This reuses the existing resolver for additional grouping-to-fact calls; it adds no graph-search algorithm, graph store, planner subsystem, or root-scoring rule. Governs R4, R7, R8, R10, R11, R12.
- KTD3. Keep an ordinary queried child in the outer left-join chain and order dependencies after CTE planning. `JoinPlanner` first produces its normal ordered joins. After `CTEPlanner` supplies the complete CTE set and before `LogicalPlanBuilder` constructs `SimpleSource`, run one stable topological ordering pass over the logical join nodes. Add an edge from each retained outer correlation cube to its dependent CTE join. Use the original `JoinPlanner` index as the ready-queue priority so unrelated joins keep their relative order; treat a dependency cycle as a planner invariant error. Do not absorb the child into the fact CTE for the ordinary path or repair order in the physical processor. This local ordering step retains zero-fact children and prevents outer join expressions from referencing a fact table that exists only inside the CTE without adding a scheduler subsystem. Governs R3, R5, R8, R10, R11.
- KTD4. Feed the complete correlation column set into the existing CTE selection, grouping, and join-building flow. Extend the array-shaped helpers in `src/server/logical-plan/cte-planner-helpers.ts` and the existing builder path in `src/server/builders/cte-builder.ts`; do not create a second CTE builder or planner path. Governs R4, R7, R8, R11.
- KTD5. Reuse the existing outer additive recomposition for `count` and additive `sum`. Private child identity columns may partition partial CTE rows, but `src/server/physical-plan/processors/selection-processor.ts` and `src/server/builders/group-by-builder.ts` must leave the final outer grouping on selected expressions only. Equal selected child values therefore merge. Governs R1, R4, R6.
- KTD6. Treat a preferred absorbed intermediate as a dual-scope correlation case. Keep the intermediate in the outer left-join chain for row retention and selected dimensions, and also represent it inside the fact CTE for fact correlation. Add the intermediate's simple correlation key to the CTE selection and grouping and to the outer CTE join condition. An absorbed intermediate named by this correlation metadata is not skipped from the outer join plan. The outer query continues to select and group the intermediate dimension from the retained outer cube; it does not rewrite that dimension to the CTE alias. Keep the current simple-column intermediate connection contract; composite absorbed routes remain outside scope. Governs R1, R5, R9, R10, R11.
- KTD7. Preserve predicate ownership. Parent and child filters stay on their outer cubes. Fact filters stay inside the fact CTE. The changed join ordering and selection rewrite must not move a fact predicate into the outer query or a child predicate into the CTE. Governs R3, R5, R10.
- KTD8. Keep root selection and path scoring unchanged. Tests use `SemanticLayerCompiler.dryRun()` or the built physical plan that emits the tested SQL to prove the selected root, SQL structure, and predicate placement, and use `QueryExecutor.execute()` to prove rows. `SemanticLayerCompiler.analyzeQuery()` supplies supplementary scoring evidence only; tests do not rely on its known path-selection trace discrepancy. Governs R1, R2, R12, R15.

### High-Level Technical Design

Root-to-fact path analysis continues to own root `joinKeys` and intermediate absorption. Independently, grouping-to-fact frontier analysis owns private aggregate correlation keys. Direct parent grain adds no frontier metadata when its correlation matches the existing root keys. Ordinary child-correlated grain adds the complete direction-aware correlation set and keeps each frontier cube before the CTE join in the outer join list. When an absorbed intermediate is also in the correlation frontier, it exists in both SQL scopes: internally for fact correlation and externally for selected dimensions and left-join row retention.

The CTE builder selects and groups the internal correlation columns and adds their outer predicates to the existing CTE join condition. After CTE planning, one stable logical topological sort places each retained outer correlation cube before its dependent CTE join. After any public optimizer runs, the planner reconstructs the semantic query from each optimized query node and re-derives private correlation metadata for surviving optimized CTEs before physical conversion. The outer query continues to group only by selected expressions and uses existing additive recomposition. Predicate processing preserves existing ownership: an outer-joined retained intermediate's base security predicate stays in its join condition, user child filters stay in the outer `WHERE`, and fact security and filters stay inside the CTE. The change adds grouping-to-fact calls to the existing resolver, but no second graph-search algorithm, physical join scheduler, side metadata store, or absorbed-dimension projection path.

### Implementation Constraints

- Keep `CTEPlanner.resolveCTEJoinKeys()` and `CTEPlanner.analyzeJoinPathToPrimary()` as the root-to-fact analysis. Derive the independent grouping frontier with the existing reverse-aware `JoinPathResolver.findPathPreferring()` operation. Do not infer correlation by rescanning only forward cube declarations.
- Build the frontier only from selected dimension and time-dimension owners. Filter-only, order-only, measure-only, and unselected cubes do not create grouping grain.
- Evaluate grouping cubes in sorted cube-name order with a fresh empty `alreadyProcessed` set for each resolver call. Do not let iteration order or the outer join plan alter the selected correlation path.
- Keep the direct parent path unchanged when no child grouping cube carries additional fact correlation, or when the frontier correlation matches the existing root `joinKeys`.
- For ordinary composite correlation, carry all `joinDef.on[]` components as one correlation set. A partial set is invalid.
- Join dependencies belong in the logical join plan. In `LogicalPlanBuilder.planWithAnalysis()`, after CTE planning and before `SimpleSource` construction, run a stable Kahn topological sort over logical joins. Add retained-correlation-cube → dependent-CTE edges, prioritize ready nodes by original `JoinPlanner` index, preserve unrelated relative order, and throw a planner invariant error on a cycle. Change `src/server/physical-plan/processors/joins-processor.ts` only to preserve an outer intermediate named by correlation metadata; do not add a physical scheduling pass.
- Keep correlation metadata private. Add `src/server/cte-correlation-metadata.ts` with a module-private `unique symbol` and internal attach, read, copy, and derivation helpers. Use the same derivation helper during initial CTE planning and immediately after `PlanOptimiser.optimise()`. Do not export this module or add declared fields to `PreAggregationCTEInfo`, `PhysicalQueryPlan`, `CTEPreAggregate`, `SimpleSource`, or `LogicalNode`.
- Store the symbol property as enumerable so existing object spreads preserve it. The runtime-to-logical and logical-to-physical conversions reconstruct objects, so each conversion must explicitly copy the private metadata.
- Treat public plan optimizers as a reconstruction boundary. Immediately after `PlanOptimiser.optimise()` returns and before physical conversion, reconstruct the semantic query from each optimized query node with the existing logical-to-semantic conversion used by physical planning, then re-derive correlation metadata for each surviving optimized CTE from that optimized query and the semantic graph using the same internal frontier helper as initial planning. Use original-query data only for information the optimized logical node does not retain and prove that fallback explicitly. Do not rely on old object identity or optimizer preservation, and do not add a `WeakMap` or other side store.
- An intermediate cube named by CTE correlation metadata remains in the outer join list even when it is also present in `intermediateJoins`. The join and predicate processors share one private `isRetainedCorrelationCube` classification. The join processor keeps the outer relation and preserves its existing base security predicate in the outer-join condition. The predicate processor continues to skip that join-owned security predicate in `WHERE` but applies user child filters there. An absorbed cube is skipped from outer scope only when it is CTE-only. This is scoped duplication across SQL query levels, not two competing logical routes.
- Selected dimensions of a retained correlated intermediate resolve from the outer cube. Do not project or rewrite them through the CTE solely because the same cube also appears inside the CTE.
- Internal correlation keys may enter CTE grouping. They must not enter the final outer `GROUP BY` unless the query selects the same expression.
- SQL assertions inspect structural fragments and table scope. Do not add full engine-specific SQL snapshots.
- Row assertions use keyed maps or deterministic sorting. Do not rely on database return order.
- Keep tests and source in library terms. Use no downstream names, schemas, payloads, or data.

### Assumptions

- `JoinPathResolver.findPathPreferring()` exposes enough direction data to orient every ordinary simple and composite correlation component when called independently from each queried grouping cube to the fact cube.
- Existing additive outer recomposition can merge private CTE partitions for `count` and additive `sum` without a new measure class.
- The child-before-CTE dependency is resolved by the planned stable logical topological ordering pass after CTE planning. The physical processor consumes that order and does not schedule joins.
- The existing selection representation can resolve a selected expression owned by a retained absorbed intermediate from the outer cube without changing public query types.

### Sequencing

U1 establishes the cross-engine fixture and completes the ordinary simple reverse-edge behavior as one vertical red-green unit, including private metadata restoration and logical join ordering. U2 proves predicate ownership and selected-value recomposition on that ordinary path. U3 independently extends U1's correlation representation to composite and declared-back-reference correlation. U4 depends on U2, then adds dual-scope retention and correlation for preferred absorbed intermediates while U3 proceeds independently. The Verification Contract begins only after U1 through U4 pass, then runs the complete cross-engine matrix, compatibility checks, and final quality boundary. Each feature-bearing unit begins with one failing behavior and retains all earlier passing cases.

## Implementation Units

### U1. Establish the fixture and correlate ordinary simple paths

- **Goal:** Create one portable parent-child-fact fixture, prove the current parent-rooted simple-key failure, and make the ordinary simple path root-invariant while keeping the child in the outer left-join chain.
- **Requirements:** R1, R2, R4, R5, R6, R8, R10, R12, R13; AE1 simple, AE2, AE3, AE4, AE5.
- **Dependencies:** None.
- **Files:**
  - `tests/helpers/databases/sqlite/schema.ts`
  - `tests/helpers/databases/sqlite/setup.ts`
  - `tests/helpers/databases/sqlite/migrations/0004_root_invariant_measure_grain.sql`
  - `tests/helpers/databases/sqlite/migrations/meta/0004_snapshot.json`
  - `tests/helpers/databases/sqlite/migrations/meta/_journal.json`
  - `tests/helpers/databases/postgres/schema.ts`
  - `tests/helpers/databases/postgres/setup.ts`
  - `tests/helpers/databases/postgres/migrations/0006_root_invariant_measure_grain.sql`
  - `tests/helpers/databases/postgres/migrations/meta/0006_snapshot.json`
  - `tests/helpers/databases/postgres/migrations/meta/_journal.json`
  - `tests/helpers/databases/mysql/schema.ts`
  - `tests/helpers/databases/mysql/setup.ts`
  - `tests/helpers/databases/mysql/migrations/0004_root_invariant_measure_grain.sql`
  - `tests/helpers/databases/mysql/migrations/meta/0004_snapshot.json`
  - `tests/helpers/databases/mysql/migrations/meta/_journal.json`
  - `tests/helpers/test-database.ts`
  - `src/server/cte-correlation-metadata.ts`
  - `src/server/logical-plan/cte-planner.ts`
  - `src/server/logical-plan/cte-planner-helpers.ts`
  - `src/server/logical-plan/logical-plan-builder.ts`
  - `src/server/physical-plan/drizzle-plan-builder.ts`
  - `src/server/builders/cte-builder.ts`
  - `src/server/executor.ts`
  - `tests/query-planner-joins.test.ts`
  - `tests/logical-plan.test.ts`
  - `tests/root-invariant-measure-grain.test.ts`
- **Approach:** Add deterministic parent, child, and fact tables to each required engine schema. Every new table has a non-null `organisation_id`, and cube definitions use the repository's existing organization security-predicate pattern. Add all simple and composite correlation columns in U1 so cross-engine migrations establish the shared table shape once. Update each engine's combined schema object and `tests/helpers/test-database.ts#getTestSchema()` to return the new tables. Generate migrations serially after the full shared shape exists: from `tests/helpers/databases/sqlite`, `tests/helpers/databases/postgres`, and `tests/helpers/databases/mysql`, run `npx drizzle-kit generate --name root_invariant_measure_grain` once in each directory. Each generation must produce the exact indexed artifacts named in the Files list: SQLite `0004_root_invariant_measure_grain.sql` plus `meta/0004_snapshot.json`; PostgreSQL `0006_root_invariant_measure_grain.sql` plus `meta/0006_snapshot.json`; MySQL `0004_root_invariant_measure_grain.sql` plus `meta/0004_snapshot.json`; and one update to each engine's `meta/_journal.json`. Inspect each diff before generating the next engine; do not hand-edit snapshots or journals, use `drizzle-kit push`, rename historical migrations, or accept unrelated drops or table rebuilds. Make PostgreSQL and MySQL setup rethrow migration errors, matching SQLite, so fixture seeding cannot continue after a failed schema migration. In every engine setup, delete rows from the new fact, child, and parent tables in dependency order before reseeding; a repeated setup run must preserve exact fixture counts. Reserve separate organization namespaces for the baseline, foreign-collision, equal-selected-value, and composite-collision fixtures. In U1, seed the baseline organization with one parent, three children, five facts with amounts `1..5`, and one zero-fact child. Also seed a foreign organization whose parent, child, fact identities, correlation values, selected dimension values, and amounts collide with the baseline fixture. Run every scenario with the baseline security context, keep every relationship inside its organization namespace, and assert that no foreign dimension, count, sum, or correlation enters the result. Filter fixture sanity reads by organization, but also verify the complete allowed organization-ID set and global counts so hidden stale rows cannot survive. Do not seed the equal-selected-value or composite-collision variants in U1. Define generic cubes and helpers in the focused test. Start with only the parent-rooted simple query and record its deterministic failure. Then add one array-shaped private correlation representation in `src/server/cte-correlation-metadata.ts`, derive the fact-nearest grouping frontier with the existing resolver, stably order logical join dependencies after CTE planning, copy and restore private metadata across reconstruction and optimizer boundaries, and feed the correlation components through the existing CTE builder flow. Green that first behavior before adding AE2, AE3, AE5, or the focused planner invariants.
- **Test scenarios, one red-green step at a time:**
  1. Fixture sanity: after running setup twice, direct database reads prove exact global and per-organization counts, the complete allowed organization-ID set, and matching organization IDs across every parent-child-fact relationship. Baseline-filtered reads still prove exactly one parent, three children, five facts, amounts total `15`, and no facts for the third child. The foreign-collision organization has its exact expected rows, and no unexpected namespace or stale row exists before planner assertions run.
  2. Red then green AE1 parent-rooted simple query: return child totals `3/6` and `2/9`, retain the third child with `null`, place the organization predicate inside the fact CTE, and emit no outer fact-table reference. Confirm the red state repeats the parent total or emits invalid SQL before the minimum production change.
  3. Red then green AE2 child-rooted simple execution; prove the selected root changes and rows match after removing the root-forcing `B.id` field.
  4. Red then green AE3 renamed-parent tie-break execution; prove the root flips while normalized rows remain equal.
  5. Red then green AE5 direct parent total; assert one row with count `5` and sum `15`.
  6. Red then green focused logical-order regressions in `tests/query-planner-joins.test.ts`: cover two retained cubes with dependent CTE joins, a transitive dependency chain, and unrelated ready joins. Assert every predecessor precedes its dependent node and the lowest original `JoinPlanner` index wins among all ready nodes. Include a case where stable Kahn order does not place a CTE immediately after its last dependency, so local relocation cannot satisfy the test.
  7. Red then green public-optimizer regressions in `tests/logical-plan.test.ts`: an optimizer that rebuilds nodes from exported declared fields still yields the same correlation metadata, valid SQL, and result; an optimizer that rewrites selected dimensions proves restoration derives from optimized query semantics rather than the original query.
  8. In `tests/logical-plan.test.ts`, use a test-local spy that preserves the real resolver behavior to count grouping-frontier calls to `JoinPathResolver.findPathPreferring()`. For a query with `n` distinct non-fact grouping-cube owners, assert exactly `n` frontier calls, each with a fresh empty processed set; adding root candidates, filters, or order members must not multiply that count. This is supplementary mechanism evidence for the bounded-path requirement, not the result-behavior seam.
  9. On every applicable step, retain the shared AE4 `null` assertion, assert the outer SQL references only tables present in outer scope, and assert that the foreign-collision organization's dimensions, counts, sums, and correlations are absent. Carry the same negative isolation assertion through optimizer-rebuilt, filtered, composite, declared-back-reference, and preferred-route scenarios without adding matrix executions.
- **Verification:** After each engine generation, verify the exact indexed SQL, snapshot, and journal paths in the Files list and review the SQL for only the intended table additions. After each acceptance case, run `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`. Before U2, use the guarded setup/readiness/teardown pattern from the Verification Contract and record these commands as passing: `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`, `npm run test:postgres -- tests/root-invariant-measure-grain.test.ts`, `npm run test:mysql -- tests/root-invariant-measure-grain.test.ts`, `npm run test:sqlite -- tests/query-planner-joins.test.ts tests/logical-plan.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts`, `npm run test:postgres -- tests/query-planner-joins.test.ts tests/logical-plan.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts`, and `npm run test:mysql -- tests/query-planner-joins.test.ts tests/logical-plan.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts`. Do not start U2 without deterministic migration output and green three-engine U1 evidence.

### U2. Prove predicate ownership and selected-value recomposition

- **Goal:** Lock filter placement and final selected-value grouping on the ordinary simple path before composite and preferred-route work depend on it.
- **Requirements:** R1, R2, R3, R4, R5, R10, R13; AE8, AE9, and AE4.
- **Dependencies:** U1 passing evidence.
- **Files:**
  - `src/server/physical-plan/processors/selection-processor.ts` only if a focused AE9 failure proves existing additive recomposition needs a change
  - `src/server/builders/group-by-builder.ts` only if a focused AE9 failure proves existing selected-expression grouping needs a change
  - `src/server/logical-plan/filter-propagation.ts` only if a focused AE8 failure proves predicate ownership changes on the corrected path
  - `tests/helpers/databases/sqlite/setup.ts`
  - `tests/helpers/databases/postgres/setup.ts`
  - `tests/helpers/databases/mysql/setup.ts`
  - `tests/root-invariant-measure-grain.test.ts`
- **Approach:** Add the six AE8 executions one at a time in the baseline organization namespace and matching security context. Keep parent and child predicates outside and fact predicates inside the CTE. Change a conditional production file only after its focused case fails and the failure traces to that owner. Immediately before the first AE9 red case, seed the equal-selected-value rows in their separate reserved organization namespace in each required engine setup. Run both AE9 scenarios under that matching security context; no relationship or fixture query crosses organization namespaces. Add the two AE9 executions and reuse existing additive recomposition so private CTE identity partitions merge into one selected-value group.
- **Test scenarios, one red-green step at a time:**
  1. Red then green AE8 parent-identity filter under the parent root, then the child root.
  2. Red then green AE8 child-identity filter under the parent root, then the child root.
  3. Red then green AE8 fact-amount filter under the parent root, then the child root. The fact predicate remains inside the CTE and all eligible children remain outer-left-joined.
  4. Seed the equal-selected-value rows, then red and green AE9 under the baseline parent root and renamed-parent child root. Each execution returns one selected group with count `5` and sum `15`, with no private child identity in the final outer grouping.
  5. After the equal-selected-value rows exist, run setup twice and prove exact global and per-organization counts, the complete allowed organization-ID set, and matching organization IDs across every relationship. Rerun the baseline scenario and prove it still sees exactly three children, five facts, sum `15`, and one zero-fact child. Retain all U1 root, direct-total, null-retention, negative foreign-collision, organization-predicate, and SQL-scope cases throughout the unit.
- **Verification:** After each red-green case, run `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`. Before U4, use the guarded database pattern and record `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`, `npm run test:postgres -- tests/root-invariant-measure-grain.test.ts`, and `npm run test:mysql -- tests/root-invariant-measure-grain.test.ts` as passing with all U1 and U2 cases. Then rerun the focused existing planner suite from U1 on SQLite, PostgreSQL, and MySQL with the exact per-engine commands named in U1.

### U3. Preserve complete correlation sets and declared back-references

- **Goal:** Apply the ordinary-path rule to composite keys and explicit fact-to-child relationships without changing simple-path behavior.
- **Requirements:** R1, R4, R5, R7, R8, R10, R13; AE1 composite, AE4, AE7.
- **Dependencies:** U1 passing evidence.
- **Files:**
  - `src/server/logical-plan/cte-planner.ts`
  - `src/server/logical-plan/cte-planner-helpers.ts`
  - `src/server/builders/cte-builder.ts`
  - `tests/helpers/databases/sqlite/setup.ts`
  - `tests/helpers/databases/postgres/setup.ts`
  - `tests/helpers/databases/mysql/setup.ts`
  - `tests/root-invariant-measure-grain.test.ts`
- **Approach:** Before the first composite red case, seed the composite-collision rows in their separate reserved organization namespace in each required engine setup. Run composite scenarios under that matching security context and keep all parent, child, and fact relationships inside the namespace. The table columns already exist from U1; U3 introduces only the data that makes incomplete correlation fail. The metadata shape and builder path are already array-shaped from U1. Populate that existing shape with the complete `joinDef.on[]` set and prove that every component participates atomically. Normalize forward and reversed edges into the same CTE-side and child-side representation. Reuse that representation when the fact declares the child back-reference.
- **Test scenarios, one red-green step at a time:**
  1. Red then green AE1 parent-rooted composite execution. The fixture collisions must make either single key component return a wrong child total.
  2. Red then green AE1 child-rooted composite execution with the root-forcing member. Compare normalized rows with the parent-rooted result.
  3. Red then green AE7 parent-rooted declared-back-reference execution.
  4. Red then green AE7 child-rooted declared-back-reference execution. Both retain the zero-fact child with `null` and match the ordinary reverse-edge result.
  5. After the composite-collision namespace exists, run setup twice and prove exact global and per-organization counts, the complete allowed organization-ID set, and matching organization IDs across every relationship. No stale or cross-organization correlation row may survive.
- **Verification:** After each red-green case, run `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`. Before final verification, use the guarded database pattern and record `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`, `npm run test:postgres -- tests/root-invariant-measure-grain.test.ts`, and `npm run test:mysql -- tests/root-invariant-measure-grain.test.ts` as passing with all U1 and U3 cases. Then rerun the focused existing planner suite from U1 on SQLite, PostgreSQL, and MySQL with the exact per-engine commands named in U1.

### U4. Retain selected intermediates across preferred CTE routes

- **Goal:** Retain selected intermediate rows while a preferred route also represents the intermediate inside the fact CTE.
- **Requirements:** R1, R5, R9, R10, R11, R13; AE6 and AE4.
- **Dependencies:** U2 passing evidence. U3 is independent and must also pass before final verification.
- **Files:**
  - `src/server/cte-correlation-metadata.ts`
  - `src/server/logical-plan/cte-planner.ts`
  - `src/server/logical-plan/logical-plan-builder.ts`
  - `src/server/physical-plan/drizzle-plan-builder.ts`
  - `src/server/builders/cte-builder.ts`
  - `src/server/physical-plan/processors/joins-processor.ts`
  - `src/server/physical-plan/processors/predicates-processor.ts`
  - `src/server/physical-plan/processors/selection-processor.ts` only if a focused failure proves existing additive measure recomposition needs a change
  - `tests/root-invariant-measure-grain.test.ts`
- **Approach:** Reuse the private correlation metadata introduced in U1 for the simple-key preferred absorbed route. Root-to-fact analysis continues to own `intermediateJoins`; the independent grouping frontier names the absorbed intermediate as an outer correlation dependency. Keep that intermediate inside the fact CTE, but use one private `isRetainedCorrelationCube` helper to narrow both outer-skip rules. `joins-processor.ts` keeps the absorbed outer relation and its base security predicate in the outer-join condition. `predicates-processor.ts` continues to exclude that join-owned security predicate from `WHERE` while applying user child filters there. An absorbed cube is skipped in outer scope only when it is CTE-only. Select and group the internal correlation key in the CTE, and append the matching outer child-to-CTE predicate to the existing CTE join condition. Resolve the selected intermediate dimension from the retained outer cube. Do not broaden `cubeIsInCTE()`, add an absorbed-dimension projection rewrite, change all absorbed-cube handling, or add composite absorbed support.
- **Test scenarios, one red-green step at a time:**
  1. Red then green AE6 parent-rooted preferred route. `dryRun()` must show `A LEFT JOIN B` before the CTE join, `B` represented separately inside the CTE, and the outer CTE join correlated by both the required root key and `B` key. `B.name` must resolve from the outer `B` relation. Execution returns `3/6`, `2/9`, and the retained null row. Then compile, without calling `QueryExecutor.execute()`, a focused child-filter variant and inspect its physical plan to prove the retained outer `B` predicate stays in outer scope. This compile-only check does not add a nineteenth matrix execution or claim separate result-row coverage.
  2. Red then green AE6 child-rooted preferred route with the root-forcing member. Remove that field for comparison and assert the same selected-value groups and measures.
  3. Retain the direct parent and ordinary reverse-path cases to prove the dual-scope behavior is limited to correlated absorbed intermediates. Assert that fact security and filters remain inside the CTE, the retained intermediate's base security predicate remains in its outer-join condition, and its focused user child filter remains in outer `WHERE`.
- **Verification:** After each red-green case, run `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`. Before final verification, use the guarded database pattern and record `npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts`, `npm run test:postgres -- tests/root-invariant-measure-grain.test.ts`, and `npm run test:mysql -- tests/root-invariant-measure-grain.test.ts` as passing with all U1, U2, and U4 cases. Then rerun the focused existing planner suite from U1 on SQLite, PostgreSQL, and MySQL with the exact per-engine commands named in U1. The complete cross-engine matrix, compatibility checks, and repository commands in the Verification Contract are the final gate after U1 through U4; any discovered defect returns to the earliest owning unit and invalidates later evidence.

## Verification Contract

### Unit Evidence

- Every acceptance-example behavior starts as one failing assertion in `tests/root-invariant-measure-grain.test.ts` and becomes green through one minimal production change. Focused planner invariants start as failing assertions in the owning focused test file named by the implementation unit.
- Retain all earlier green cases before adding the next case.
- Record selected-root, SQL, and predicate-scope evidence from `SemanticLayerCompiler.dryRun()` or the built physical plan that emits the tested SQL. Use `SemanticLayerCompiler.analyzeQuery()` only as supplementary scoring evidence. Record result evidence from `QueryExecutor.execute()`. The bounded-path proof runs with `npm run test:sqlite -- tests/logical-plan.test.ts` and observes real calls at `JoinPathResolver.findPathPreferring()` through a behavior-preserving test-local spy.
- Compare rows with keyed maps or deterministic sorting. Assert SQL structure and table scope, not full SQL snapshots.

### Database Setup and Readiness

Run all final database-backed verification and repository checks inside one fail-fast shell wrapper. Install the `EXIT` trap immediately after successful setup. The trap must preserve the original failing status, run teardown on readiness, test, typecheck, lint, or build failure, and report teardown failure when the body succeeds:

```bash
bash -c '
set -Eeuo pipefail
cleanup() {
  status=$?
  trap - EXIT
  set +e
  npm run test:teardown
  teardown_status=$?
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  exit "$teardown_status"
}
npm run test:setup
trap cleanup EXIT
for attempt in {1..60}; do nc -z localhost 54333 && break; sleep 1; done
nc -z localhost 54333 || { echo "PostgreSQL did not become ready on port 54333" >&2; exit 1; }
for attempt in {1..60}; do nc -z localhost 33077 && break; sleep 1; done
nc -z localhost 33077 || { echo "MySQL did not become ready on port 33077" >&2; exit 1; }
npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts
npm run test:postgres -- tests/root-invariant-measure-grain.test.ts
npm run test:mysql -- tests/root-invariant-measure-grain.test.ts
npm run test:sqlite -- tests/query-planner-joins.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts
npm run test:postgres -- tests/query-planner-joins.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts
npm run test:mysql -- tests/query-planner-joins.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts
npm run typecheck
npm run lint
npm run test:sqlite
npm run test:postgres
npm run test:mysql
npm run build
'
```

A readiness failure blocks all later database-backed verification. The focused and final command lists below define the required order and evidence inside this wrapper; do not run them as an unguarded setup-through-teardown sequence.

### Focused Cross-Engine Matrix

Run the focused file on each required engine:

```bash
npm run test:sqlite -- tests/root-invariant-measure-grain.test.ts
npm run test:postgres -- tests/root-invariant-measure-grain.test.ts
npm run test:mysql -- tests/root-invariant-measure-grain.test.ts
```

The focused file must execute the matrix once per engine in this exact order:

1. AE1 parent-rooted simple key.
2. AE2 child-rooted simple key.
3. AE1 parent-rooted composite key.
4. AE1 child-rooted composite key.
5. AE3 renamed-parent child-rooted tie-break.
6. AE5 direct parent total.
7. AE6 parent-rooted preferred route.
8. AE6 child-rooted preferred route.
9. AE7 parent-rooted fact back-reference.
10. AE7 child-rooted fact back-reference.
11. AE8 parent identity filter, parent-rooted.
12. AE8 parent identity filter, child-rooted.
13. AE8 child identity filter, parent-rooted.
14. AE8 child identity filter, child-rooted.
15. AE8 fact amount filter, parent-rooted.
16. AE8 fact amount filter, child-rooted.
17. AE9 equal selected values, parent-rooted.
18. AE9 equal selected values, renamed-parent child-rooted.

AE4 and negative foreign-organization isolation remain shared assertions on every applicable execution; they do not add matrix executions.

### Preserved Planner Behavior

Run the relevant planner suites on every required engine:

```bash
npm run test:sqlite -- tests/query-planner-joins.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts
npm run test:postgres -- tests/query-planner-joins.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts
npm run test:mysql -- tests/query-planner-joins.test.ts tests/reverse-join-path.test.ts tests/fan-out-prevention.test.ts tests/cte-downstream-join.test.ts
```

### Final Repository Checks

Inside the guarded wrapper from Database Setup and Readiness, run the final repository checks in this order:

```bash
npm run typecheck
npm run lint
npm run test:sqlite
npm run test:postgres
npm run test:mysql
npm run build
```

The wrapper's `EXIT` trap owns teardown and preserves the first failing status. If a command fails, keep the responsible unit open. Record the failure, fix only the owning behavior, and rerun the focused proof before repeating the complete guarded sequence. A linter or typecheck result does not replace engine execution.

### Review Gates

- `ce-code-review` must review the final diff after all commands above pass.
- The implementation maintainer gauntlet reruns the targeted SQLite test and the available PostgreSQL and MySQL checks against the exact reviewed diff. It uses the same guarded setup, bounded readiness checks, and status-preserving `EXIT` trap from this contract; no post-setup failure may bypass `npm run test:teardown`.
- Any code or test edit after review invalidates review and final verification evidence.
- No commit, push, pull request, issue, comment, or other outward action is part of this plan.

## Definition of Done

- U1 records deterministic red evidence before its first production change; U1 through U4 then have fresh passing evidence, and all units respect their dependency order.
- All 18 mandatory executions pass on SQLite, PostgreSQL, and MySQL with deterministic row comparison, and every applicable execution excludes the colliding foreign organization's dimensions, measures, and correlations.
- Child-grain count and additive sum values remain equal across root changes and the specified rename tie-break.
- Eligible zero-fact children remain present with `null` measures.
- Direct parent totals remain count `5` and sum `15`.
- Ordinary reverse edges, ordinary composite keys, declared fact back-references, and preferred simple-key absorbed routes emit valid SQL and return the required rows.
- Parent and child filters stay outside the CTE; fact filters stay inside it; fact filters do not collapse the child left join.
- Equal selected child values form one final SQL group under both roots.
- Existing root-scoring and focused planner suites pass unchanged across the three required engines.
- `npm run typecheck`, `npm run lint`, `npm run test:sqlite`, `npm run test:postgres`, `npm run test:mysql`, and `npm run build` pass against the final diff.
- Diff review confirms no public API, root-scoring, store, planner-subsystem, downstream-specific, or unrelated change.
- `ce-code-review` and the implementation maintainer gauntlet approve the exact final diff.
- Temporary diagnosis files, abandoned approaches, generated debug output, and unrelated lockfile churn are absent.
- No outward action occurs without separate authorization.

### Sources

- Branch `diagnose-root-selection` at source state `ba2f35e7` — baseline code examined for root selection and join planning.
- `src/server/logical-plan/cte-planner.ts` — pre-aggregation key derivation and forward-only downstream-key lookup.
- `src/server/logical-plan/plan-analysis-reporter.ts` — root selection by dimension count with an alphabetical tie-break.
- `src/server/resolvers/join-path-resolver.ts` — bidirectional reverse index and path scoring.
- `src/server/physical-plan/processors/joins-processor.ts` — inter-cube join construction and intermediate-cube absorption.
- `.github/workflows/ci.yml` — engine matrix behind R13.
