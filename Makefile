.PHONY: setup generate-abis keys lint fmt test test-contracts test-integration

setup:
	pnpm install --frozen-lockfile
	git submodule update --init --depth 1
	$(MAKE) generate-abis

generate-abis:
	forge build --root contracts src lib/safe-contracts/contracts/GnosisSafeL2.sol lib/safe-contracts/contracts/proxies/GnosisSafeProxy.sol
	pnpm --filter @ledgera/abis generate

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

CHAIN_COMPOSE = docker compose --env-file chain/versions.env --env-file .env --env-file .env.generated -f chain/compose/docker-compose.chain.yml
CHAIN_NODE = node --env-file-if-exists=.env --env-file=.env.generated

REPLICA_COMPOSE = docker compose --env-file chain/versions.env --env-file .env -f chain/compose/docker-compose.replica.yml
CONTROL_COMPOSE = $(REPLICA_COMPOSE) --project-name ledgera-control --profile control

.PHONY: chain-image replica-up replica-down replica-reset replica-compare control-up control-down control-compare

chain-image:
	bash chain/scripts/build-op-reth.sh

replica-up:
	bash chain/scripts/check-op-reth-image.sh op-reth-replica $(REPLICA_COMPOSE) --project-name ledgera-replica
	$(REPLICA_COMPOSE) --project-name ledgera-replica up -d --wait op-node-replica

replica-down:
	$(REPLICA_COMPOSE) --project-name ledgera-replica down

replica-reset:
	$(REPLICA_COMPOSE) --project-name ledgera-replica down --volumes

replica-compare:
	bash chain/scripts/compare-heads.sh

control-up: replica-up
	$(CONTROL_COMPOSE) up -d --wait op-node-control

control-down:
	$(CONTROL_COMPOSE) down --volumes

control-compare:
	bash chain/scripts/compare-deposit.sh "$(DEPOSIT_HASH)"

.PHONY: chain-deploy chain-up chain-down chain-logs chain-shell status fund-l1

chain-deploy:
	bash chain/scripts/deploy-l1.sh

chain-up:
	test -s chain/runtime/genesis.json
	test -s chain/runtime/rollup.json
	test -s chain/runtime/jwt.txt
	bash chain/scripts/check-op-reth-image.sh op-reth $(CHAIN_COMPOSE)
	$(CHAIN_COMPOSE) up -d --build --wait

chain-down:
	$(CHAIN_COMPOSE) down

chain-logs:
	$(CHAIN_COMPOSE) logs --follow

chain-shell:
	$(CHAIN_COMPOSE) run --rm --no-deps chain-shell

status:
	$(CHAIN_COMPOSE) ps --all
	$(CHAIN_NODE) chain/scripts/status.ts

fund-l1:
	$(CHAIN_NODE) chain/scripts/fund-l1.ts

ANVIL_COMPOSE = docker compose --env-file chain/versions.env -f docker-compose.anvil.yml

.PHONY: anvil-up anvil-down l2-bootstrap

anvil-up:
	$(ANVIL_COMPOSE) up -d --build --wait
	BOOTSTRAP_MODE=anvil bash chain/scripts/bootstrap-l2.sh

anvil-down:
	$(ANVIL_COMPOSE) down

l2-bootstrap:
	BOOTSTRAP_MODE=devnet bash chain/scripts/bootstrap-l2.sh
