export const root: string
export function sha256(bytes: string | Uint8Array): string
export function generatedPath(relative: string): string
export function atomicBytes(file: string, bytes: string | Uint8Array): void
export function newAssetStage(name: 'scan' | 'ocr'): string
export function publishAssetStage(stage: string, name: 'scan' | 'ocr'): void
export function fetchBytes(url: string, maxBytes: number, allowedHosts: string[]): Promise<Buffer>
export function fileEntries(directory: string, names: string[]): Record<string, { size: number; sha256: string }>
