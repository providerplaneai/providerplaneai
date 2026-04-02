# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/providerplaneai/providerplaneai/compare/v0.2.1...v0.3.0) (2026-04-02)


### Features

* **providers:** Added initial Mistral integration as well as OCR support across providers ([#17](https://github.com/providerplaneai/providerplaneai/issues/17)) ([07ee927](https://github.com/providerplaneai/providerplaneai/commit/07ee9273cd0440a2bc0bafcd0d087136a2653754))

## [Unreleased]

### Added

- Added first pass at Mistral support
- Add OCR support for all providers

## [0.2.1] - 2026-03-24

### Fixed

- Brought the release process back in sync with npm publishing behavior and updated npm settings after GitHub Actions publish issues.

### Added

- Automated changelog and release PR generation via Release Please.

## [0.2.0] - 2026-03-09

### Added

- Workflow deterministic integration suite for streaming hooks, fanout/aggregate, nested workflows, retries, timeouts, resume, and built-in capabilities.
- Provider-backed live workflow integration smoke tests (gated by `RUN_WORKFLOW_LIVE_INTEGRATION=1` and provider API keys).
- Built-in `approvalGate` capability and `saveFile` capability with default executor registration.

### Changed

- OpenAI chat message-part normalization to support mixed input content shapes safely.
- Integration test layout split between deterministic and provider-backed sections.

### Fixed

- Live workflow failures caused by non-array chat message content in OpenAI chat path.
- Streaming smoke test aggregation when workflow step output is a structured message object.
