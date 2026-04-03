# voicemode-channel Makefile

.PHONY: help build clean test publish release

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  build     Compile TypeScript to dist/"
	@echo "  clean     Remove build artifacts"
	@echo "  test      Build and test from tarball"
	@echo "  publish   Build and publish to npm"
	@echo "  release   Bump version, build, publish, and release plugin"
	@echo "  help      Show this help"

build:
	npm run build

clean:
	rm -rf dist/ *.tgz

test: clean build
	@echo "Packing and testing..."
	npm pack
	@tmpdir=$$(mktemp -d) && \
		npm install --prefix "$$tmpdir" ./voicemode-channel-*.tgz && \
		"$$tmpdir/node_modules/.bin/voicemode-channel" auth status && \
		rm -rf "$$tmpdir" && \
		echo "" && \
		echo "Test passed."
	rm -f voicemode-channel-*.tgz

publish: clean build
	@echo "Publishing to npm..."
	@echo ""
	@echo "Current version: $$(node -p 'require("./package.json").version')"
	@echo ""
	npm publish

release:
	@claude-plugin-release
	$(MAKE) publish
