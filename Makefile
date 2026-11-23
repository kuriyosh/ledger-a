.PHONY: setup keys lint fmt test test-contracts test-integration

setup:
	pnpm install --frozen-lockfile
	git submodule update --init --depth 1

keys:
	node --env-file-if-exists=.env chain/scripts/derive-accounts.ts

lint:
	pnpm lint
	forge fmt --check --root contracts

fmt:
	pnpm fmt
	forge fmt --root contracts

test:
	pnpm test

test-contracts:
	forge test --root contracts

test-integration:
	pnpm test:integration
