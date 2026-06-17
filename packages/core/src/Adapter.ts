import { Effect, FileSystem, Path } from "effect"
import type { ToolPull } from "./Domain"
import type { PullPeriod } from "./Period"
import { TailingsPaths } from "./TailingsPaths"

/**
 * The ambient services every adapter's `pull` reads through. A pull is written
 * against these, then `makeArchivePull` closes over them so the value exposed by
 * the Archive service has no requirements of its own.
 */
export type ArchiveEnv = FileSystem.FileSystem | Path.Path | TailingsPaths

export type ArchivePull<E> = (dir: string, period?: PullPeriod) => Effect.Effect<ToolPull, E, ArchiveEnv>

/**
 * Capture the three ambient services once at layer construction and provide them
 * into `pull`, yielding a self-contained `(dir, period) => Effect<ToolPull, E>`.
 * This is the wiring every `*ArchiveLive` layer used to repeat by hand.
 */
export const makeArchivePull = <E>(pull: ArchivePull<E>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const paths = yield* TailingsPaths
    const path = yield* Path.Path
    return (dir: string, period?: PullPeriod): Effect.Effect<ToolPull, E> =>
      pull(dir, period).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(TailingsPaths, paths),
        Effect.provideService(Path.Path, path)
      )
  })
