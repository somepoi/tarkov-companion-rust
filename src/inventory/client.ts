import { screenshotSize } from '../scan/imageBudget'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { GameMode } from '../api/client'
import type { Grid } from '../scan/core'
import type { QuantityEvidence } from '../scan/quantity'

export interface LocalProfile {
  id: string
  mode: GameMode
  name: string
}
export interface Container {
  id: string
  profileId: string
  name: string
  kind: string
  columns: number
  rows: number
  revision: number
  currentSnapshotId: string | null
}
export interface CellBox {
  column: number
  row: number
  width: number
  height: number
  rotated: boolean
}
export type Fir = 'yes' | 'no' | 'unknown'
export interface Stack {
  id: string
  itemId: string | null
  quantity: number | null
  fir: Fir
  location: CellBox
  provenance: {
    identityConfirmed: boolean
    quantityConfirmed: boolean
    method: string
    screenshotHash: string | null
    observationId: string | null
    corrected: boolean
  }
  neverSell: boolean
  dogtag?: { level: number; confirmed: boolean }
  durability?: { percent: number; confirmed: boolean }
  joinedSources?: JoinedSource[]
}
export interface JoinedSource {
  viewId: string; stackId: string; screenshotHash: string
  viewColumn: number; viewRow: number; columns: number; rows: number
  location: CellBox; sourceGrid: Grid | null
}
export interface Observation {
  id: string
  screenshotHash: string
  location: CellBox
  candidates: { itemId: string; error: number }[]
  quantity: number | null
  fir: Fir
  reviewed: boolean
  sourceGrid?: Grid
  quantityEvidence?: QuantityEvidence
}
export interface ScanDraft {
  fullCoverageConfirmed: boolean
  reviewConfirmed: boolean
  capturedAt: string
  algorithmVersion: string
  catalogVersion: string
  stacks: Stack[]
  observations: Observation[]
}
/** Local screenshot draft registered into one stable container layout. */
export interface RegisteredView {
  id: string
  screenshotHash: string
  column: number
  row: number
  columns: number
  rows: number
  coverageConfirmed: boolean
  draft: ScanDraft
}
export interface ScanComposition {
  stableLayoutConfirmed: boolean
  views: RegisteredView[]
  choices: { column: number; row: number; viewId: string }[]
  joins?: FootprintJoin[]
}
export interface FootprintJoin {
  id: string
  parts: { viewId: string; stackId: string }[]
  samePhysicalItemConfirmed: boolean
  reviewConfirmed: boolean
  output: Stack
}
export interface CompositionPreview {
  coveredCells: number
  totalCells: number
  unresolvedCells: number
  conflicts: { column: number; row: number; viewIds: string[] }[]
  splitStacks: string[]
  draft: ScanDraft | null
}
export const composeViews = (sessionId: string, composition: ScanComposition) =>
  inventoryCall<CompositionPreview>({ operation: 'composeViews', sessionId, composition })
export const saveComposition = (sessionId: string, composition: ScanComposition) =>
  inventoryCall<CompositionPreview>({ operation: 'saveComposition', sessionId, composition })
export const getComposition = (sessionId: string) =>
  inventoryCall<ScanComposition | null>({ operation: 'getComposition', sessionId })

export interface ScanSession {
  id: string
  containerId: string
  baseRevision: number
  scope: 'full' | 'partial'
  status: 'draft' | 'committed' | 'abandoned'
  draft: ScanDraft | null
}
export interface Snapshot {
  id: string
  revision: number
  capturedAt: string
  algorithmVersion: string
  catalogVersion: string
  fullCoverageConfirmed: boolean
  stacks: Stack[]
}
export interface Inventory {
  profile: LocalProfile
  containers: { container: Container; snapshot: Snapshot | null }[]
  legacy: {
    profileId: string
    sourceHash: string
    counts: Record<string, number>
  } | null
}
export interface CommitResult {
  containerId: string
  snapshotId: string
  revision: number
  sessionId: string | null
  previousSnapshotId: string | null
}

export interface UserReserve {
  extraBuffer: number
  minimumTotal: number
  neverSell: boolean
}
export interface PlanningPreferences {
  hideoutTargets: Record<string, number>
  craftBatches: Record<string, number>
  barterBatches: Record<string, number>
  reserves: Record<string, UserReserve>
}
export interface PlanningState {
  profileId: string
  revision: number
  preferences: PlanningPreferences
}
export interface Requirement {
  id: string
  source: string
  kind: { kind: 'consume' } | { kind: 'reusable'; group: string }
  alternatives: string[]
  quantity: number | null
  fir: 'any' | 'required' | 'unknown'
  minimumDogtagLevel?: number
  durability?: { minimum: number; maximum: number }
}
export interface RecommendationPlan {
  profileId: string
  mode: GameMode
  catalogVersion: string
  progressionRevision: string
  planRevision: string
  horizon: string
  containerRevisions: Record<string, number>
  saleDecisionsComplete: boolean
  coverageGaps: string[]
  allocations: {
    containerId: string
    snapshotId: string
    stackId: string
    itemId: string
    quantity: number
    requirementIds: string[]
    reason: string
  }[]
  stacks: {
    containerId: string
    snapshotId: string
    stackId: string
    itemId: string | null
    location: CellBox
    portions: {
      recommendation: 'KEEP' | 'SELL' | 'REVIEW'
      quantity: number | null
      reason: string
    }[]
  }[]
  items: {
    itemId: string
    confirmedOwned: number
    keep: number
    sell: number
    reviewKnownQuantity: number
    unknownStacks: number
  }[]
  unfulfilled: {
    requirementIds: string[]
    alternatives: string[]
    quantity: number | null
    reason: string
  }[]
}

export const nativeInventoryAvailable = () => isTauri()

export async function inventoryCall<T>(
  operation: Record<string, unknown>,
): Promise<T> {
  if (!isTauri())
    throw new Error(
      'Persistent Stash Manager requires the native Rust build. Your existing Item Collection remains available.',
    )
  try {
    return await invoke<T>('inventory_call', { operation })
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : JSON.stringify(error), {
      cause: error,
    })
  }
}

export async function archiveScreenshot(image: Blob): Promise<string> {
  await screenshotSize(image)
  return invoke<string>(
    'archive_screenshot',
    new Uint8Array(await image.arrayBuffer()),
  )
}

export async function readArchivedScreenshot(hash: string): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>('read_archived_screenshot', { hash })
  return new Blob([bytes])
}

export const commitPartial = (sessionId: string, expectedRevision: number, idempotencyKey: string) =>
  inventoryCall<CommitResult>({ operation: 'commitPartial', request: { sessionId, expectedRevision, idempotencyKey } })
