# Changelog

## [0.4.0](https://github.com/pm990320/agent-hooks/compare/v0.3.3...v0.4.0) (2026-04-24)


### Features

* add agent-hooks-setup skill for guided installation and configuration ([9b75bd3](https://github.com/pm990320/agent-hooks/commit/9b75bd37f3d518a749513400abe4f04e720f6d64))
* affected-only testing — detect vitest/jest and emit two-form run ([0ef7222](https://github.com/pm990320/agent-hooks/commit/0ef7222fefeb06c7a9bcde6f7877680dcab51aa4))
* **cli:** add monorepo install and doctor support ([4bd92f1](https://github.com/pm990320/agent-hooks/commit/4bd92f17294f6cac005a28d8eec2ce46f4160d49))
* **config:** add monorepo project loader ([6fe172a](https://github.com/pm990320/agent-hooks/commit/6fe172a26d7684c1b2b3576d04539bd8f741cf19))
* configurable scope on git hooks (staged | changed | all) ([43aa9fa](https://github.com/pm990320/agent-hooks/commit/43aa9fa2b2069c20ac81dcc3097bbf9c45b6e9b9))
* **hooks:** fan out monorepo hook dispatch ([d9b898f](https://github.com/pm990320/agent-hooks/commit/d9b898f716552c2f31f663dc27502394cf20f61d))
* **init:** add monorepo root scaffolding ([c0d1a15](https://github.com/pm990320/agent-hooks/commit/c0d1a15b10b591e051c2b7a3e91e6c27cc11a754))
* per-file linting in node detector + linter recipes in docs ([d9f867e](https://github.com/pm990320/agent-hooks/commit/d9f867e784cbd9b5e941b2d3cef181ee9aab7f1c))
* **run:** add monorepo target dispatch ([2da8e67](https://github.com/pm990320/agent-hooks/commit/2da8e671ed93a4f29c660a0962a6576eb52da0d0))
* **runners:** add grouped invocation modes ([b9a5912](https://github.com/pm990320/agent-hooks/commit/b9a5912c966015a8e86eaefa1b110afbbb328a4d))
* **runners:** add workspace path routing helpers ([673fab0](https://github.com/pm990320/agent-hooks/commit/673fab0db1b8b0a70da86211269e58835e72caed))
* when-changed gates match pipeline input files, not git state ([25dcd7f](https://github.com/pm990320/agent-hooks/commit/25dcd7fe056769bb765b3a1ae95852ec598ef813))


### Bug Fixes

* **agent:** load skill template from packaged dist ([a1bcb6d](https://github.com/pm990320/agent-hooks/commit/a1bcb6d3f8d2ef4e9dc3d8fed9590dde95ba73c8))
* use pull_request_target for bot PRs so CI runs without approval ([198bc1d](https://github.com/pm990320/agent-hooks/commit/198bc1d4291faeef1a51dceb0c29cacd67d763cc))


### Reverts

* remove pull_request_target (also suppressed by GITHUB_TOKEN guard) ([69c771c](https://github.com/pm990320/agent-hooks/commit/69c771ccfa6cd2dacd37c470e3cf2e0c849be3ed))


### Documentation

* add monorepo design note ([f727b10](https://github.com/pm990320/agent-hooks/commit/f727b10538710e8011f293298e19244037d9df3f))
* expand monorepo guidance ([798907c](https://github.com/pm990320/agent-hooks/commit/798907c6492e5092a7b10ed3f00b193ab003fb5c))

## [0.3.3](https://github.com/pm990320/agent-hooks/compare/v0.3.2...v0.3.3) (2026-04-17)


### Bug Fixes

* use npx npm@latest for publish instead of broken in-place upgrade ([3d2c88b](https://github.com/pm990320/agent-hooks/commit/3d2c88b65b96bf78b8980cde9da0da9e108ada45))

## [0.3.2](https://github.com/pm990320/agent-hooks/compare/v0.3.1...v0.3.2) (2026-04-17)


### Bug Fixes

* upgrade npm to latest in publish-npm for OIDC trusted publisher support ([481b4c8](https://github.com/pm990320/agent-hooks/commit/481b4c8c42a2162fdfb7c2ec6f03a78f9a542401))

## [0.3.1](https://github.com/pm990320/agent-hooks/compare/v0.3.0...v0.3.1) (2026-04-17)


### Bug Fixes

* resilient release-please output names + rebuild fallback when preview is missing ([626ddaa](https://github.com/pm990320/agent-hooks/commit/626ddaa073edf9c75aa8fce3d473ec1a301b130e))
* use git tag -f for rolling major tag (REST API prefix-matches and 404s on short tags) ([3bd6b98](https://github.com/pm990320/agent-hooks/commit/3bd6b98d31eb589787fd0bbf6b420e3de1cebab3))

## [0.3.0](https://github.com/pm990320/agent-hooks/compare/v0.2.0...v0.3.0) (2026-04-17)


### Features

* node-compatible npm distribution via bun build --target=node ([38f1b72](https://github.com/pm990320/agent-hooks/commit/38f1b725ed844302078128ddeb7041bcaa806a29))
* thin npm wrapper package with postinstall binary download ([a550b37](https://github.com/pm990320/agent-hooks/commit/a550b37a87281354d717f4692b0598151d772458))


### Bug Fixes

* cross-platform shebang replacement in build:npm (bun -e instead of sed) ([71d968c](https://github.com/pm990320/agent-hooks/commit/71d968cd9d3151736fe8e147f71b7f72ce44796b))
* lint/typecheck/test errors in spawn shim and scoped package name ([a1b0694](https://github.com/pm990320/agent-hooks/commit/a1b06949abe1704bd3bd1d74f9210f990e6e5cc5))
* read release-please v4 manifest-mode outputs correctly ([0bd5134](https://github.com/pm990320/agent-hooks/commit/0bd51348e039d119a4ae8f09622b4dce744897cd))
* scope package to @pm990320/agent-hooks + use npm trusted publishers (OIDC) ([61975b2](https://github.com/pm990320/agent-hooks/commit/61975b29e4faf97547a53494d15392b583cd2eba))
* scoped package tarball name in npm smoke test ([ea5f004](https://github.com/pm990320/agent-hooks/commit/ea5f004e3a3fef111b54ccf1499c249dd1102888))
* use linux-compatible sed -i (no backup suffix arg) ([3c55951](https://github.com/pm990320/agent-hooks/commit/3c55951c6b63421b8b1857480e45decf4a189d45))


### Documentation

* clean up README — npm/bun install first, remove early-dev status, tighten copy ([9b535b2](https://github.com/pm990320/agent-hooks/commit/9b535b24e02616245445c87df958da176edb2341))

## [0.2.0](https://github.com/pm990320/agent-hooks/compare/v0.1.0...v0.2.0) (2026-04-16)


### Features

* explicit darwin ad-hoc codesign step in CI matrices ([05ef879](https://github.com/pm990320/agent-hooks/commit/05ef879e2944c93f90a57b9aa3329aaa231c36c9))
* native Codex CLI hook handler ([d981111](https://github.com/pm990320/agent-hooks/commit/d981111afdee6d524279927e53b05a048ca2d190))
* remap agent-hook pipeline failures to exit 2 + portable darwin post-build sign ([ec680f0](https://github.com/pm990320/agent-hooks/commit/ec680f0fa4ebfbac56b54085a300a6318841cf38))


### Bug Fixes

* build darwin release binaries on macos runners so they're signed ([f4618eb](https://github.com/pm990320/agent-hooks/commit/f4618eb34fd25b4b64895125bf71064bdba7dda7))
* change-gate evaluator no longer crashes on PR checkouts ([f7b68c6](https://github.com/pm990320/agent-hooks/commit/f7b68c6451bc6a56eb3e29a66b1ba56350df27f9))
* per-agent opt-in for hook exit-code 2 remap ([d8a0629](https://github.com/pm990320/agent-hooks/commit/d8a062981663f7bc7e0ab058232daa3fbbe24348))
* pin bun to 1.2.15 so darwin --compile output is linker-signed ([32c5942](https://github.com/pm990320/agent-hooks/commit/32c5942b2a60d4a5b238f92fb5c16743718a88a7))
* self-heal unsigned darwin binaries via codesign in install.sh ([319e246](https://github.com/pm990320/agent-hooks/commit/319e2466a045ecbbde21bdb96098de265c9c0d73))
* use matching-refs for exact-tag existence check in rolling-major ([3ab8676](https://github.com/pm990320/agent-hooks/commit/3ab8676dbd6084dc850147a75b81ca566e0eb898))

## 0.1.0 (2026-04-15)


### Features

* add CLAUDE.md / AGENTS.md marker-block integration ([d179d58](https://github.com/pm990320/agent-hooks/commit/d179d586ee1bb2390833d918b6f89e1d3c21cf14))
* initial release of agent-hooks ([c24cb31](https://github.com/pm990320/agent-hooks/commit/c24cb31cd24f2176248e704445de4f99b2676a02))
* marketplace branding, rolling major tag, release process doc ([b1d8315](https://github.com/pm990320/agent-hooks/commit/b1d83152530c43e8d1d93129f6c0579d2b208904))
* release pipeline rework, commitlint, license audit, smarter install.sh ([c74f06a](https://github.com/pm990320/agent-hooks/commit/c74f06a07ba47f46a8df3ed0db34d09c66fa86c9))


### Bug Fixes

* drop stream-drain deadlock when a buffered step hits timeout-ms ([93088f3](https://github.com/pm990320/agent-hooks/commit/93088f3657cf8ed09817ca74f1ad5c69ec46680d))
* fold preview build into release-please workflow ([b79d4c5](https://github.com/pm990320/agent-hooks/commit/b79d4c5b2a846a1edcb945f9656292a8d0520e5a))
* reset process registry before each test, not just after ([f8f4244](https://github.com/pm990320/agent-hooks/commit/f8f4244a7fcf4fff090c986a4694ee506d843a11))
* stabilize integration runCli cwd + pin first release to 0.1.0 ([378effd](https://github.com/pm990320/agent-hooks/commit/378effdd8615db8155559366b0d807c26df6b75f))
