# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

