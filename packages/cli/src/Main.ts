#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { AppLayer, readPackageMetadata } from "./App"
import { command } from "./Commands"

Effect.gen(function*() {
  const metadata = yield* readPackageMetadata()
  yield* Command.run(command, { version: metadata.version })
}).pipe(
  Effect.provide(AppLayer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain
)
