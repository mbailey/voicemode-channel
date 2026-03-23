.PHONY: release help

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  release   Create a new release (bump version, commit, tag, push)"
	@echo "  help      Show this help"

release:
	@claude-plugin-release
