# voicemode-channel Makefile

.PHONY: help build clean test test-unit run inspect shell audit publish release

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  build     Compile TypeScript to dist/"
	@echo "  clean     Remove build artifacts"
	@echo "  run       Build and run MCP server (stdio)"
	@echo "  test      Run unit tests, build, and test from tarball"
	@echo "  test-unit Run unit tests"
	@echo "  inspect   Open MCP Inspector web UI"
	@echo "  shell     Open mcptools interactive shell"
	@echo "  audit     Run npm security audit"
	@echo "  publish   Build and publish to npm"
	@echo "  release   Bump version, build, publish, and release plugin"
	@echo "  help      Show this help"

build:
	npm run build

clean:
	rm -rf dist/ *.tgz

run: build
	node dist/index.js

inspect: build
	npx @modelcontextprotocol/inspector node dist/index.js

shell: build ## Interactive MCP shell (brew install mcptools)
	mcptools shell node dist/index.js
# Shell examples:
#   tools                              List available tools
#   status                             Check connection state
#   reply {"text":"hello from cli"}    Send a voice reply
#   profile                            View agent profile
#   profile {"voice":"af_sky"}         Update profile fields
#   /h                                 Show all commands
#   /q                                 Quit

test-unit:  ## Run unit tests
	npx tsx maildir.test.ts

test: test-unit clean build
	@echo "Packing and testing..."
	npm pack
	@tmpdir=$$(mktemp -d) && \
		npm install --prefix "$$tmpdir" ./voicemode-channel-*.tgz && \
		"$$tmpdir/node_modules/.bin/voicemode-channel" auth status && \
		rm -rf "$$tmpdir" && \
		echo "" && \
		echo "Test passed."
	rm -f voicemode-channel-*.tgz

audit:
	npm audit --audit-level=high

publish: clean audit build
	@echo "Publishing to npm..."
	@echo ""
	@echo "Current version: $$(node -p 'require("./package.json").version')"
	@echo ""
	npm publish

release:
	@claude-plugin-release
	$(MAKE) publish
